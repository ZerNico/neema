import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { Effect } from "effect";
import { DesktopError } from "@chat/desktop-rpc";

/**
 * Path containment on the host: the one place that decides whether a path the site
 * named may be read here, for a preview or a save.
 *
 * The site is remote code, and the chat's computer writes inside the very folders
 * it previews, links included. So a name is a request, never an authorisation, and
 * this module answers only against a root the *user* picked from a native dialog
 * (or the chat's own workspace, which is container territory).
 *
 * Resolving the string is not enough. `resolve()` collapses `..` but knows
 * nothing about symlinks, so `notes -> /etc` inside the folder would pass a
 * textual check and read the host. Every answer here therefore ends at
 * `realpath`, and because a write targets a file that does not exist yet, the
 * walk resolves the nearest existing ancestor and rebuilds the tail from it.
 * Refusals name the path the caller supplied, never a resolved host path the
 * caller did not already know.
 */

const trimmed = (path: string) =>
  path.length > parse(path).root.length ? path.replace(/[\\/]+$/, "") : path;

// Windows spells the drive letter either way; nothing else may differ.
const exact = (path: string) =>
  process.platform === "win32" ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path;

/**
 * macOS links /tmp, /var and /etc into /private, and its data volume holds the writable folders
 * under a second spelling: the system's own aliases, not a planted link.
 */
const unaliased = (path: string) =>
  process.platform === "darwin"
    ? path
        .replace(/^\/System\/Volumes\/Data(?=\/)/, "")
        .replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "")
    : path;

/** Whether `real` is `path` itself, not somewhere a link along it leads (system aliases aside). */
export const isOwnRealPath = (path: string, real: string) =>
  exact(unaliased(trimmed(normalize(path)))) === exact(unaliased(trimmed(real)));

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
      if (yield* exists(current)) return { base: current, trail: trail.toReversed() };
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
  /** Relative to the folder, `.` for the folder itself. */
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
  pinned = false,
  /** How refusals name the path: the caller's own address for it. */
  named = requested,
): Effect.Effect<ResolvedPath, DesktopError> =>
  Effect.gen(function* () {
    // A missing root is not a missing file: the workspace dir is created on
    // demand and a moved folder reports through the status, so resolving
    // against a root that is not there yet must not read as "not found".
    const realRoot = yield* realOrFail(root, named).pipe(
      Effect.mapError(
        () =>
          new DesktopError({
            reason: "no-folder",
            message: "The folder you chose is no longer available.",
          }),
      ),
    );

    // A pinned root (an attached folder, recorded by its real path) must still be that path:
    // judged where it is used, so a link swapped in after any earlier check is not followed.
    if (pinned && !isOwnRealPath(root, realRoot))
      return yield* new DesktopError({
        reason: "no-folder",
        message: "The folder you chose is no longer available.",
      });
    const target = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested);
    const { base, trail } = yield* existingAncestor(target, named);
    const realBase = yield* realOrFail(base, named);
    if (!within(realRoot, realBase)) return yield* Effect.fail(outside(named));

    const absolute = trail.length === 0 ? realBase : join(realBase, ...trail);
    // Rebuilding from a proven-inside ancestor cannot escape, but the join is
    // cheap to re-check and this is the boundary worth being paranoid at.
    if (!within(realRoot, absolute)) return yield* Effect.fail(outside(named));

    const relative = absolute === realRoot ? "." : absolute.slice(realRoot.length + 1);
    return { absolute, relative };
  });

/** What the strip shows for a folder. No longer the model's address. */
export const folderName = (folder: string) => basename(folder) || folder;
