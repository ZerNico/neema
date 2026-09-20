import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";
import { Effect } from "effect";
import { DesktopError } from "@chat/desktop-rpc";

/**
 * Path containment: the one place that decides whether a path the site named is
 * allowed to be touched.
 *
 * The site is remote code. It may name any path it likes, and the model driving
 * it may have read that path out of a file. So a name is a request, never an
 * authorisation, and this module answers only against a root the *user* picked
 * from a native dialog (or the chat's own workspace, which is container
 * territory).
 *
 * Resolving the string is not enough. `resolve()` collapses `..` but knows
 * nothing about symlinks, so `notes -> /etc` inside the folder would pass a
 * textual check and read the host. Every answer here therefore ends at
 * `realpath`, and because a write targets a file that does not exist yet, the
 * walk resolves the nearest existing ancestor and rebuilds the tail from it.
 * Refusals name the path the caller supplied, never a resolved host path the
 * caller did not already know.
 */

const outside = (named: string) =>
  new DesktopError({
    reason: "outside-folder",
    message: `${named} is outside the folders this chat can reach.`,
  });

export const exists = (path: string) =>
  Effect.tryPromise({
    try: () =>
      lstat(path).then(
        () => true,
        (cause: unknown) => {
          // A dangling link exists and must reach realpath, never the missing tail.
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
          throw cause;
        },
      ),
    catch: () => new DesktopError({ reason: "failed", message: "Could not read that path." }),
  });

const realOrFail = (path: string, named: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: () => new DesktopError({ reason: "not-found", message: `${named} does not exist.` }),
  });

/** True when `candidate` is the root itself or sits underneath it. */
const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The nearest ancestor of `target` that exists, plus the segments below it that
 * do not. A write to `src/new/file.ts` in a folder with no `new/` still has to
 * be checked, and the only thing that can be `realpath`-ed is `src`.
 */
const existingAncestor = (target: string, named: string) =>
  Effect.gen(function* () {
    const trail: string[] = [];
    let current = target;
    for (;;) {
      if (yield* exists(current)) return { base: current, trail: trail.reverse() };
      const { dir, base, root } = parse(current);
      // A path whose every component is missing cannot be contained by anything
      // we can prove, so treat it as outside rather than guessing.
      if (dir === current || base === "" || current === root) {
        return yield* Effect.fail(outside(named));
      }
      trail.push(base);
      current = dir;
    }
  });

export interface ResolvedPath {
  /** Absolute, symlink-free, proven to sit inside the folder. */
  readonly absolute: string;
  /** How it is named back to the model: relative to the folder, POSIX-ish. */
  readonly relative: string;
}

/**
 * Resolves a path against one folder root, or refuses. Absolute paths are the
 * model's ordinary address, accepted when they resolve inside the root. A
 * relative path resolves against the root too: nothing sends one, but
 * containment decides either way, so refusing it would be ceremony.
 */
export const resolveInFolder = (
  root: string,
  requested: string,
): Effect.Effect<ResolvedPath, DesktopError> =>
  Effect.gen(function* () {
    // A missing root is not a missing file: the workspace dir is created on
    // demand and a moved folder reports through the status, so resolving
    // against a root that is not there yet must not read as "not found".
    const realRoot = yield* realOrFail(root, requested).pipe(
      Effect.mapError(
        () =>
          new DesktopError({
            reason: "no-folder",
            message: "The folder you chose is no longer available.",
          }),
      ),
    );

    const target = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested);
    const { base, trail } = yield* existingAncestor(target, requested);
    const realBase = yield* realOrFail(base, requested);
    if (!within(realRoot, realBase)) return yield* Effect.fail(outside(requested));

    const absolute = trail.length === 0 ? realBase : join(realBase, ...trail);
    // Rebuilding from a proven-inside ancestor cannot escape, but the join is
    // cheap to re-check and this is the boundary worth being paranoid at.
    if (!within(realRoot, absolute)) return yield* Effect.fail(outside(requested));

    const relative = absolute === realRoot ? "." : absolute.slice(realRoot.length + 1);
    return { absolute, relative };
  });

/** What the strip shows for a folder. No longer the model's address. */
export const folderName = (folder: string) => basename(folder) || folder;

export interface LocatedPath extends ResolvedPath {
  /** The root of the folder the path fell in, absolute and real. */
  readonly root: string;
}

/**
 * An absolute path, resolved against a set of folder roots, each with a
 * display name. The containment proof is `resolveInFolder`'s; this only picks
 * which root the path belongs to and renders the receipt as
 * `rootName/relative`, so the transcript keeps the short form while the
 * model's address space is absolute. A path under no root is refused.
 *
 * `outside-folder` from one root means "not mine" only when the requested
 * string never textually sat inside that root: the path belongs to someone
 * else and the next root may own it. When the string *did* sit inside this
 * root and still resolved outside, a symlink or a `..` walked it out, and
 * letting the escape target match a neighbouring root would widen what a
 * symlink inside this folder can reach. That failure is the final answer.
 * `no-folder` (the root itself is gone) says nothing about the path, so it
 * is skipped too; every other failure is this root's to report.
 */
export const resolveAmongRoots = (
  roots: ReadonlyArray<{ name: string; root: string }>,
  requested: string,
): Effect.Effect<LocatedPath, DesktopError> =>
  Effect.gen(function* () {
    if (!isAbsolute(requested)) return yield* Effect.fail(outside(requested));
    const normalized = resolve(requested);
    for (const { name, root } of roots) {
      const resolved = yield* Effect.result(resolveInFolder(root, requested));
      if (resolved._tag === "Failure") {
        const { reason } = resolved.failure;
        if (reason === "no-folder") continue;
        if (reason === "outside-folder") {
          const ownsTextually = yield* Effect.result(
            Effect.map(realOrFail(root, requested), (realRoot) => within(realRoot, normalized)),
          );
          if (ownsTextually._tag === "Success" && !ownsTextually.success) continue;
          return yield* Effect.fail(resolved.failure);
        }
        return yield* Effect.fail(resolved.failure);
      }
      const found = resolved.success;
      return {
        root:
          found.relative === "." ? found.absolute : found.absolute.slice(0, -found.relative.length - 1),
        absolute: found.absolute,
        relative: found.relative === "." ? name : `${name}/${found.relative}`,
      };
    }
    return yield* Effect.fail(outside(requested));
  });
