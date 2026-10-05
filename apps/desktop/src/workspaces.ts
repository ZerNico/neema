import { cp, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  DesktopError,
  LIMITS,
  LocalTransactionId,
  WorkspaceId,
  type PendingPromotion,
  type PromotionReceipt,
  type StagedFileReceipt,
} from "@chat/desktop-rpc";

/**
 * App-managed conversation workspaces plus transient composer staging. The
 * workspace id is validated again here because this is the filesystem sink;
 * callers that bypass the RPC decoder still cannot choose a path segment.
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

const transactionId = (value: string) => {
  if (!Schema.is(LocalTransactionId)(value)) throw failed("The local transaction id is invalid.");
  return value;
};

interface PromotionFile {
  readonly stagedName: string;
  readonly finalName: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
}

interface PromotionJournal {
  readonly version: 1;
  readonly conversationId: string;
  readonly reservationId: string;
  readonly submissionId: string;
  readonly files: ReadonlyArray<PromotionFile>;
}

export interface Workspaces {
  ensure(conversationId: string): Effect.Effect<string, DesktopError>;
  /** The directory without creating it. */
  path(conversationId: string): string;
  stageFile(
    conversationId: string,
    submissionId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Effect.Effect<StagedFileReceipt, DesktopError>;
  stageFileFromPath(
    conversationId: string,
    submissionId: string,
    fileName: string,
    sourcePath: string,
  ): Effect.Effect<StagedFileReceipt, DesktopError>;
  /** Bytes straight into the workspace root, named apart from anything there. */
  landFile(
    conversationId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Effect.Effect<StagedFileReceipt, DesktopError>;
  discardStagedFile(
    conversationId: string,
    submissionId: string,
    name: string,
  ): Effect.Effect<void, DesktopError>;
  discardSubmission(
    conversationId: string,
    submissionId: string,
  ): Effect.Effect<void, DesktopError>;
  promote(
    conversationId: string,
    submissionId: string,
    reservationId: string,
  ): Effect.Effect<PromotionReceipt, DesktopError>;
  commit(conversationId: string, reservationId: string): Effect.Effect<void, DesktopError>;
  rollback(conversationId: string, reservationId: string): Effect.Effect<void, DesktopError>;
  pendingPromotions(): Effect.Effect<ReadonlyArray<PendingPromotion>, DesktopError>;
  clone(fromConversationId: string, toConversationId: string): Effect.Effect<void, DesktopError>;
  discard(conversationId: string): Effect.Effect<void, DesktopError>;
  /** Best-effort cleanup for transient files not protected by a promotion journal. */
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
): Promise<StagedFileReceipt> => {
  await mkdir(target, { recursive: true });
  const tmp = join(target, `.tmp-${randomSuffix()}`);
  try {
    const bytes = await write(tmp);
    const name = sanitizeName(fileName);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`;
      try {
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
  const stagingRoot = join(root, ".staging");
  const promotionsRoot = join(root, ".promotions");
  const stageDir = (conversationId: string, submissionId: string) =>
    join(stagingRoot, workspaceId(conversationId), transactionId(submissionId));
  const journalPath = (reservationId: string) =>
    join(promotionsRoot, `${transactionId(reservationId)}.json`);

  const writeJournal = async (journal: PromotionJournal) => {
    await mkdir(promotionsRoot, { recursive: true });
    const final = journalPath(journal.reservationId);
    const tmp = `${final}.${randomSuffix()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(journal), { encoding: "utf8", flag: "wx" });
      await rename(tmp, final);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  };

  const readJournal = async (reservationId: string): Promise<PromotionJournal | null> => {
    try {
      const value: unknown = JSON.parse(await readFile(journalPath(reservationId), "utf8"));
      if (!value || typeof value !== "object") return null;
      const candidate = value as Partial<PromotionJournal>;
      if (
        candidate.version !== 1 ||
        !Schema.is(WorkspaceId)(candidate.conversationId) ||
        !Schema.is(LocalTransactionId)(candidate.reservationId) ||
        !Schema.is(LocalTransactionId)(candidate.submissionId) ||
        !Array.isArray(candidate.files)
      )
        return null;
      const files = candidate.files.filter(
        (file): file is PromotionFile =>
          !!file &&
          typeof file === "object" &&
          typeof file.stagedName === "string" &&
          typeof file.finalName === "string" &&
          typeof file.bytes === "number" &&
          typeof file.device === "string" &&
          typeof file.inode === "string",
      );
      if (files.length !== candidate.files.length) return null;
      return { ...candidate, files } as PromotionJournal;
    } catch {
      return null;
    }
  };

  const pendingJournals = async (): Promise<PromotionJournal[]> => {
    let names: string[];
    try {
      names = await readdir(promotionsRoot);
    } catch {
      return [];
    }
    const journals = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJournal(name.slice(0, -5))),
    );
    return journals.filter((journal): journal is PromotionJournal => journal !== null);
  };

  const stageFromBytes = async (
    conversationId: string,
    submissionId: string,
    fileName: string,
    bytes: Uint8Array,
  ) => {
    if (bytes.length > LIMITS.importBytes)
      throw new DesktopError({
        reason: "too-large",
        message: "That file is too large to add to the workspace.",
      });
    return landFile(stageDir(conversationId, submissionId), fileName, async (tmp) => {
      await writeFile(tmp, bytes, { flag: "wx" });
      return bytes.length;
    });
  };

  const stageFromPath = async (
    conversationId: string,
    submissionId: string,
    fileName: string,
    sourcePath: string,
  ) => {
    const info = await stat(sourcePath);
    if (!info.isFile())
      throw new DesktopError({ reason: "failed", message: "Only a file can be added." });
    if (info.size > LIMITS.importPathBytes)
      throw new DesktopError({
        reason: "too-large",
        message: "That file is too large to add to the workspace.",
      });
    return landFile(stageDir(conversationId, submissionId), fileName, async (tmp) => {
      await cp(sourcePath, tmp, { errorOnExist: true });
      return info.size;
    });
  };

  const rollbackJournal = async (journal: PromotionJournal) => {
    const staged = stageDir(journal.conversationId, journal.submissionId);
    const workspace = dir(journal.conversationId);
    for (const file of journal.files) {
      try {
        const [source, destination] = await Promise.all([
          stat(join(staged, file.stagedName), { bigint: true }),
          stat(join(workspace, file.finalName), { bigint: true }),
        ]);
        if (
          source.dev.toString() === file.device &&
          source.ino.toString() === file.inode &&
          destination.dev === source.dev &&
          destination.ino === source.ino
        )
          await rm(join(workspace, file.finalName), { force: true });
      } catch {
        // A missing or replaced path is not ours to remove.
      }
    }
    await rm(journalPath(journal.reservationId), { force: true });
  };

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

    stageFile: (conversationId, submissionId, fileName, bytes) =>
      Effect.tryPromise({
        try: () => stageFromBytes(conversationId, submissionId, fileName, bytes),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not stage that file."),
      }),

    stageFileFromPath: (conversationId, submissionId, fileName, sourcePath) =>
      Effect.tryPromise({
        try: () => stageFromPath(conversationId, submissionId, fileName, sourcePath),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not stage that file."),
      }),

    landFile: (conversationId, fileName, bytes) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, () =>
            landFile(dir(conversationId), fileName, async (tmp) => {
              await writeFile(tmp, bytes, { flag: "wx" });
              return bytes.length;
            }),
          ),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not save that file."),
      }),

    discardStagedFile: (conversationId, submissionId, name) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, async () => {
            const protectedBy = (await pendingJournals()).some(
              (journal) =>
                journal.conversationId === conversationId && journal.submissionId === submissionId,
            );
            if (protectedBy) throw failed("Those files are currently being sent.");
            await rm(join(stageDir(conversationId, submissionId), sanitizeName(name)), {
              force: true,
            });
          }),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not remove that staged file."),
      }),

    discardSubmission: (conversationId, submissionId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, async () => {
            const protectedBy = (await pendingJournals()).some(
              (journal) =>
                journal.conversationId === conversationId && journal.submissionId === submissionId,
            );
            if (protectedBy) throw failed("Those files are currently being sent.");
            await rm(stageDir(conversationId, submissionId), { recursive: true, force: true });
          }),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not remove those staged files."),
      }),

    promote: (conversationId, submissionId, reservationId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, async () => {
            transactionId(submissionId);
            transactionId(reservationId);
            const existing = await readJournal(reservationId);
            if (existing) {
              if (
                existing.conversationId !== conversationId ||
                existing.submissionId !== submissionId
              )
                throw failed("That promotion belongs to another submission.");
              return {
                reservationId,
                files: existing.files.map(({ stagedName, finalName, bytes }) => ({
                  stagedName,
                  finalName,
                  bytes,
                })),
              };
            }
            const conflict = (await pendingJournals()).some(
              (journal) => journal.conversationId === conversationId,
            );
            if (conflict) throw failed("Another workspace send is still being reconciled.");

            const staged = stageDir(conversationId, submissionId);
            const entries = (await readdir(staged, { withFileTypes: true }))
              .filter((entry) => entry.isFile() && !entry.name.startsWith(".tmp-"))
              .toSorted((left, right) => left.name.localeCompare(right.name));
            if (entries.length === 0) throw failed("There are no staged files to send.");
            const workspace = dir(conversationId);
            await mkdir(workspace, { recursive: true });
            let journal: PromotionJournal = {
              version: 1,
              conversationId,
              reservationId,
              submissionId,
              files: [],
            };
            await writeJournal(journal);
            try {
              for (const entry of entries) {
                const sourcePath = join(staged, entry.name);
                const source = await stat(sourcePath, { bigint: true });
                const clean = sanitizeName(entry.name);
                const ext = extname(clean);
                const stem = clean.slice(0, clean.length - ext.length);
                let landed = false;
                for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
                  const finalName = attempt === 0 ? clean : `${stem}-${attempt}${ext}`;
                  const file: PromotionFile = {
                    stagedName: entry.name,
                    finalName,
                    bytes: Number(source.size),
                    device: source.dev.toString(),
                    inode: source.ino.toString(),
                  };
                  journal = { ...journal, files: [...journal.files, file] };
                  await writeJournal(journal);
                  try {
                    await link(sourcePath, join(workspace, finalName));
                    landed = true;
                    break;
                  } catch (cause) {
                    journal = { ...journal, files: journal.files.slice(0, -1) };
                    await writeJournal(journal);
                    if (isExistsError(cause)) continue;
                    throw cause;
                  }
                }
                if (!landed) throw failed("Could not choose a unique workspace file name.");
              }
              return {
                reservationId,
                files: journal.files.map(({ stagedName, finalName, bytes }) => ({
                  stagedName,
                  finalName,
                  bytes,
                })),
              };
            } catch (cause) {
              await rollbackJournal(journal);
              throw cause;
            }
          }),
        catch: (cause) =>
          cause instanceof DesktopError
            ? cause
            : failed("Could not add those files to the workspace."),
      }),

    commit: (conversationId, reservationId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, async () => {
            const journal = await readJournal(reservationId);
            if (!journal) return;
            if (journal.conversationId !== conversationId)
              throw failed("That promotion belongs to another workspace.");
            await rm(stageDir(conversationId, journal.submissionId), {
              recursive: true,
              force: true,
            });
            await rm(journalPath(reservationId), { force: true });
          }),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not finish the workspace send."),
      }),

    rollback: (conversationId, reservationId) =>
      Effect.tryPromise({
        try: () =>
          serialized(`workspace:${workspaceId(conversationId)}`, async () => {
            const journal = await readJournal(reservationId);
            if (!journal) return;
            if (journal.conversationId !== conversationId)
              throw failed("That promotion belongs to another workspace.");
            await rollbackJournal(journal);
          }),
        catch: (cause) =>
          cause instanceof DesktopError ? cause : failed("Could not roll back the workspace send."),
      }),

    pendingPromotions: () =>
      Effect.tryPromise({
        try: async () =>
          (await pendingJournals()).map(({ conversationId, reservationId, submissionId }) => ({
            conversationId,
            reservationId,
            submissionId,
          })),
        catch: () => failed("Could not inspect pending workspace sends."),
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

    sweepTransient: () =>
      Effect.promise(async () => {
        const protectedSubmissions = new Set(
          (await pendingJournals()).map(
            (journal) => `${journal.conversationId}/${journal.submissionId}`,
          ),
        );
        try {
          for (const conversation of await readdir(stagingRoot, { withFileTypes: true })) {
            if (!conversation.isDirectory()) continue;
            const conversationPath = join(stagingRoot, conversation.name);
            for (const submission of await readdir(conversationPath, { withFileTypes: true })) {
              if (!submission.isDirectory()) continue;
              const key = `${conversation.name}/${submission.name}`;
              const path = join(conversationPath, submission.name);
              if (!protectedSubmissions.has(key) && (await stale(path)))
                await rm(path, { recursive: true, force: true });
            }
          }
        } catch {
          // No staging root yet.
        }
        try {
          for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.name.startsWith(".partial-") || !(await stale(join(root, entry.name))))
              continue;
            await rm(join(root, entry.name), { recursive: true, force: true });
          }
        } catch {
          // No workspace root yet.
        }
        try {
          for (const name of await readdir(promotionsRoot)) {
            if (!name.endsWith(".tmp") && !name.includes(".tmp")) continue;
            const path = join(promotionsRoot, name);
            if (await stale(path)) await rm(path, { force: true });
          }
        } catch {
          // No promotion root yet.
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
        stageFile: (conversationId, submissionId, fileName, bytes) =>
          forOrigin().stageFile(conversationId, submissionId, fileName, bytes),
        stageFileFromPath: (conversationId, submissionId, fileName, sourcePath) =>
          forOrigin().stageFileFromPath(conversationId, submissionId, fileName, sourcePath),
        landFile: (conversationId, fileName, bytes) =>
          forOrigin().landFile(conversationId, fileName, bytes),
        discardStagedFile: (conversationId, submissionId, name) =>
          forOrigin().discardStagedFile(conversationId, submissionId, name),
        discardSubmission: (conversationId, submissionId) =>
          forOrigin().discardSubmission(conversationId, submissionId),
        promote: (conversationId, submissionId, reservationId) =>
          forOrigin().promote(conversationId, submissionId, reservationId),
        commit: (conversationId, reservationId) =>
          forOrigin().commit(conversationId, reservationId),
        rollback: (conversationId, reservationId) =>
          forOrigin().rollback(conversationId, reservationId),
        pendingPromotions: () => forOrigin().pendingPromotions(),
        clone: (from, to) => forOrigin().clone(from, to),
        discard: (conversationId) => forOrigin().discard(conversationId),
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
