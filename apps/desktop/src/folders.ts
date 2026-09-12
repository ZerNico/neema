import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
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
 * from a native dialog.
 *
 * Resolving the string is not enough. `resolve()` collapses `..` but knows
 * nothing about symlinks, so `notes -> /etc` inside the folder would pass a
 * textual check and read the host. Every answer here therefore ends at
 * `realpath`, and because a write targets a file that does not exist yet, the
 * walk resolves the nearest existing ancestor and rebuilds the tail from it.
 */

const outside = (path: string) =>
  new DesktopError({
    reason: "outside-folder",
    message: `${path} is outside the folder you chose.`,
  });

const exists = (path: string) =>
  Effect.tryPromise({
    try: () =>
      access(path, constants.F_OK)
        .then(() => true)
        .catch(() => false),
    catch: () => new DesktopError({ reason: "failed", message: "Could not read that path." }),
  });

const realOrFail = (path: string) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: () => new DesktopError({ reason: "not-found", message: `${path} does not exist.` }),
  });

/** True when `candidate` is the root itself or sits underneath it. */
const within = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The nearest ancestor of `target` that exists, plus the segments below it that
 * do not. A write to `src/new/file.ts` in a folder with no `new/` still has to
 * be checked, and the only thing that can be `realpath`-ed is `src`.
 */
const existingAncestor = (target: string) =>
  Effect.gen(function* () {
    const trail: string[] = [];
    let current = target;
    for (;;) {
      if (yield* exists(current)) return { base: current, trail: trail.reverse() };
      const { dir, base, root } = parse(current);
      // A path whose every component is missing cannot be contained by anything
      // we can prove, so treat it as outside rather than guessing.
      if (dir === current || base === "" || current === root) {
        return yield* Effect.fail(outside(target));
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
 * Resolves a site-supplied relative path against a granted folder, or refuses.
 *
 * An absolute path is refused outright rather than checked. Accepting one that
 * happens to fall inside the folder would teach callers that absolute paths are
 * a supported way to address files, and the next one would not fall inside.
 */
export const resolveInFolder = (
  root: string,
  requested: string,
): Effect.Effect<ResolvedPath, DesktopError> =>
  Effect.gen(function* () {
    if (isAbsolute(requested)) return yield* Effect.fail(outside(requested));
    const realRoot = yield* realOrFail(root).pipe(
      Effect.mapError(
        () =>
          new DesktopError({
            reason: "no-folder",
            message: "The folder you chose is no longer available.",
          }),
      ),
    );

    const target = resolve(realRoot, requested);
    const { base, trail } = yield* existingAncestor(target);
    const realBase = yield* realOrFail(base);
    if (!within(realRoot, realBase)) return yield* Effect.fail(outside(requested));

    const absolute = trail.length === 0 ? realBase : join(realBase, ...trail);
    // Rebuilding from a proven-inside ancestor cannot escape, but the join is
    // cheap to re-check and this is the boundary worth being paranoid at.
    if (!within(realRoot, absolute)) return yield* Effect.fail(outside(requested));

    const relative = absolute === realRoot ? "." : absolute.slice(realRoot.length + 1);
    return { absolute, relative };
  });

/** What the strip shows for a folder, and the first segment of every path into it. */
export const folderName = (folder: string) => basename(folder) || folder;

export interface LocatedPath extends ResolvedPath {
  /** Which attached folder the path fell in, by name. */
  readonly folder: string;
  /** The folder's root, absolute and real. */
  readonly root: string;
}

const notFound = (path: string) =>
  new DesktopError({
    reason: "not-found",
    message: `${path} does not start with the name of an attached folder.`,
  });

/**
 * Resolves a model-supplied path whose first segment names one of several
 * attached folders (`site/src/index.ts`). Everything after the name goes
 * through `resolveInFolder` against that folder's root, so the containment
 * proof is the same one a single folder gets. The result names the path the
 * way the model will see it back, prefix included.
 */
export const resolveAcross = (
  folders: ReadonlyArray<string>,
  requested: string,
): Effect.Effect<LocatedPath, DesktopError> =>
  Effect.gen(function* () {
    if (isAbsolute(requested)) return yield* Effect.fail(outside(requested));
    const normalised = requested.replaceAll("\\", "/").replace(/^\.\//, "");
    const [head, ...rest] = normalised.split("/");
    const root = folders.find((folder) => folderName(folder) === head);
    if (!head || head === "." || head === ".." || root === undefined)
      return yield* Effect.fail(notFound(requested));
    const inner = rest.join("/");
    const resolved = yield* resolveInFolder(root, inner === "" ? "." : inner);
    return {
      folder: head,
      root:
        resolved.relative === "."
          ? resolved.absolute
          : resolved.absolute.slice(0, -resolved.relative.length - 1),
      absolute: resolved.absolute,
      relative: resolved.relative === "." ? head : `${head}/${resolved.relative}`,
    };
  });
