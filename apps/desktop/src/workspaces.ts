import { cp, link, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { DesktopError, LIMITS, WorkspaceId } from "@chat/desktop-rpc";

/**
 * App-managed conversation workspaces, each mounted at `/workspace` in its chat's computer. The
 * workspace id is validated again here because this is the filesystem sink; callers that bypass
 * the RPC decoder still cannot choose a path segment.
 */

const sanitizeName = (name: string) => {
  const base = basename(name)
    // oxlint-disable-next-line eslint/no-control-regex -- filenames must replace ASCII controls.
    .replace(/[\0-\x1f<>:"/\\|?*]/g, "_")
    .trim();
  return (base === "" || base === "." || base === ".." ? "file" : base).slice(0, 200);
};

const failed = (message: string) => new DesktopError({ reason: "failed", message });
const randomSuffix = () => randomBytes(12).toString("hex");
const isExistsError = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";

const workspaceId = (value: string) => {
  if (!Schema.is(WorkspaceId)(value)) throw failed("The workspace id is invalid.");
  return value;
};

/** A file landed in a workspace: the name it got there. */
export interface LandedFile {
  readonly name: string;
  readonly bytes: number;
}

export interface Workspaces {
  ensure(conversationId: string): Effect.Effect<string, DesktopError>;
  /** The directory without creating it. */
  path(conversationId: string): string;
  /** Bytes straight into the workspace root, named apart from anything there. */
  landFile(
    conversationId: string,
    fileName: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Effect.Effect<LandedFile, DesktopError>;
  clone(fromConversationId: string, toConversationId: string): Effect.Effect<void, DesktopError>;
  discard(conversationId: string): Effect.Effect<void, DesktopError>;
  /** Chats with a workspace here. */
  chats(): Effect.Effect<ReadonlyArray<string>>;
  /** Best-effort cleanup of interrupted copies and what older versions left behind. */
  sweepTransient(): Effect.Effect<void>;
}

const STALE_TRANSIENT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NAME_ATTEMPTS = 10_000;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const landFile = async (
  target: string,
  fileName: string,
  write: (tmp: string) => Promise<number>,
  signal?: AbortSignal,
): Promise<LandedFile> => {
  signal?.throwIfAborted();
  await mkdir(target, { recursive: true });
  signal?.throwIfAborted();
  const tmp = join(target, `.tmp-${randomSuffix()}`);
  try {
    const bytes = await write(tmp);
    signal?.throwIfAborted();
    const name = sanitizeName(fileName);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`;
      try {
        // A submitted link may commit. Cancellation only prevents publication
        // that has not yet been submitted, never rolls back an existing file.
        signal?.throwIfAborted();
        await link(tmp, join(target, candidate));
        return { name: candidate, bytes };
      } catch (cause) {
        if (isExistsError(cause)) continue;
        throw cause;
      }
    }
    throw failed("Could not choose a unique name for that file.");
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
};

const measure = async (source: string) => {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > LIMITS.cloneDepth) {
      truncated = true;
      return;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > LIMITS.cloneEntries) {
        truncated = true;
        return;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) bytes += (await stat(full)).size;
      if (truncated || bytes > LIMITS.cloneBytes) return;
    }
  };
  await walk(source, 0);
  return { bytes, entries, truncated };
};

const stale = async (path: string) => {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_TRANSIENT_MS;
  } catch {
    return false;
  }
};

const makeWorkspaces = (root: string): Workspaces => {
  const dir = (conversationId: string) => join(root, workspaceId(conversationId));
  const locks = new Map<string, Promise<void>>();
  const serialized = async <A>(key: string, task: () => Promise<A>): Promise<A> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    locks.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  };

  const ensure = (conversationId: string) =>
    Effect.tryPromise({
      try: () =>
        serialized(`workspace:${workspaceId(conversationId)}`, async () => {
          const target = dir(conversationId);
          await mkdir(target, { recursive: true });
          return target;
        }),
      catch: (cause) =>
        cause instanceof DesktopError ? cause : failed("Could not create this chat's workspace."),
    });

  return {
    path: dir,
    ensure,

    landFile: (conversationId, fileName, bytes, signal) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, () =>
            landFile(
              dir(conversationId),
              fileName,
              async (tmp) => {
                signal?.throwIfAborted();
                await writeFile(tmp, bytes, { flag: "wx", signal });
                signal?.throwIfAborted();
                return bytes.length;
              },
              signal,
            ),
          ),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not save that file."),
      }),

    clone: (fromConversationId, toConversationId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(toConversationId)}`, async () => {
            const source = dir(fromConversationId);
            if (!(await exists(source))) return;
            const measured = await measure(source);
            if (
              measured.truncated ||
              measured.bytes > LIMITS.cloneBytes ||
              measured.entries > LIMITS.cloneEntries
            )
              throw new DesktopError({
                reason: "too-large",
                message: "The workspace is too large to copy into the branch.",
              });
            const dest = dir(toConversationId);
            if (await exists(dest))
              throw new DesktopError({
                reason: "already-exists",
                message: "The branch already has a workspace.",
              });
            await mkdir(root, { recursive: true });
            const partial = join(
              root,
              `.partial-${workspaceId(toConversationId)}-${randomSuffix()}`,
            );
            try {
              await cp(source, partial, { recursive: true, errorOnExist: true });
              await rename(partial, dest);
            } finally {
              await rm(partial, { recursive: true, force: true }).catch(() => {});
            }
          }),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not copy the workspace."),
      }),

    discard: (conversationId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, () =>
            rm(dir(conversationId), { recursive: true, force: true }),
          ),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not remove the workspace."),
      }),

    chats: () =>
      Effect.promise(async () => {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        // Staging, journals and partial copies start with a dot; a workspace is named by its chat.
        return entries
          .filter((entry) => entry.isDirectory() && Schema.is(WorkspaceId)(entry.name))
          .map((entry) => entry.name);
      }),

    sweepTransient: () =>
      Effect.promise(async () => {
        // Composer staging and its promotion journals: gone with local drops.
        await rm(join(root, ".staging"), { recursive: true, force: true }).catch(() => {});
        await rm(join(root, ".promotions"), { recursive: true, force: true }).catch(() => {});
        try {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.name.startsWith(".partial-") || !(await stale(join(root, entry.name))))
              continue;
            await rm(join(root, entry.name), { recursive: true, force: true });
          }
        } catch {
          // No workspace root yet.
        }
      }),
  };
};

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, Workspaces>()(
  "desktop/WorkspaceRegistry",
) {
  static readonly layerAt = (origin: () => string, userData: string) =>
    Layer.sync(WorkspaceRegistry, () => {
      const byRoot = new Map<string, Workspaces>();
      const forOrigin = () => {
        const root = workspacesRoot(origin(), userData);
        const existing = byRoot.get(root);
        if (existing) return existing;
        const made = makeWorkspaces(root);
        byRoot.set(root, made);
        return made;
      };
      return WorkspaceRegistry.of({
        path: (conversationId) => forOrigin().path(conversationId),
        ensure: (conversationId) => forOrigin().ensure(conversationId),
        landFile: (conversationId, fileName, bytes, signal) =>
          forOrigin().landFile(conversationId, fileName, bytes, signal),
        clone: (from, to) => forOrigin().clone(from, to),
        discard: (conversationId) => forOrigin().discard(conversationId),
        chats: () => forOrigin().chats(),
        sweepTransient: () => forOrigin().sweepTransient(),
      });
    });

  static readonly layerEphemeral = (root: string) =>
    Layer.sync(WorkspaceRegistry, () => WorkspaceRegistry.of(makeWorkspaces(root)));
}

/**
 * `<userData>/workspaces/<origin-hash>/`. The hash keeps two servers' chats
 * apart without putting a URL on the filesystem.
 */
export const workspacesRoot = (origin: string, userData: string) =>
  join(userData, "workspaces", createHash("sha256").update(origin).digest("hex").slice(0, 16));
