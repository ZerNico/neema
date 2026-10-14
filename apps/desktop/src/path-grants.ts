import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { loadScopedGrants, type ScopedGrants } from "./scoped-grants.ts";

/**
 * Paths outside the attached folders that commands may read, because the
 * person said so: one exact file or folder, for the answer that asked, the
 * chat, or every chat. Read only; a writable place is an attached folder.
 */
export type PathGrants = ScopedGrants;

const trimmed = (path: string) =>
  path.length > parse(path).root.length ? path.replace(/[\\/]+$/, "") : path;
// macOS and Windows file systems ignore case by default, and realpath returns the stored case.
const comparable = (path: string) => (process.platform === "linux" ? path : path.toLowerCase());

// Windows spells the drive letter either way; nothing else may differ.
const exact = (path: string) =>
  process.platform === "win32" ? path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : path;

/**
 * macOS links /tmp, /var and /etc into /private, and its data volume holds the writable folders
 * under a second spelling: the system's own aliases, not a planted link.
 */
export const unaliased = (path: string) =>
  process.platform === "darwin"
    ? path
        .replace(/^\/System\/Volumes\/Data(?=\/)/, "")
        .replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "")
    : path;

const inside = (parent: string, child: string) => {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export interface PathRules {
  readonly home: string;
  /**
   * Never granted, whatever is asked: credential paths, the app's own data (permissions, other
   * chats' workspaces, cookies) and the folder holding commands' private folders.
   */
  readonly denied: readonly string[];
}

/**
 * The real path a grant would open, or why it cannot be granted. A filesystem
 * root, the home folder or a folder above it would open far more than one
 * thing, and a denied path stays denied, so asking for one is refused upfront.
 */
export const checkPathGrant = async (
  path: unknown,
  rules: PathRules,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    return { ok: false, reason: "Name one absolute path." };
  let real: string;
  try {
    real = await resolve(path);
  } catch {
    return { ok: false, reason: "That path does not exist." };
  }
  // The person approved the path as asked; a link would grant whatever it points at. Case
  // counts too, since a case-sensitive volume may hold a link differing from its target in case.
  if (!isOwnRealPath(path, real))
    return {
      ok: false,
      reason: `That path leads to ${real}. Ask for that path itself.`,
    };
  const refusal = pathRefusal(real, rules);
  return refusal ? { ok: false, reason: refusal } : { ok: true, path: real };
};

// Judged in one spelling, so a rule written as /var/... still covers /private/var/... .
const same = (path: string) => comparable(unaliased(trimmed(normalize(path))));

/** Whether `real` is `path` itself, not somewhere a link along it leads (system aliases aside). */
export const isOwnRealPath = (path: string, real: string) =>
  exact(unaliased(trimmed(normalize(path)))) === exact(unaliased(trimmed(real)));

/** Whether a path is a denied place, holds one, or lies inside one. */
export const touchesDenied = (path: string, denied: readonly string[]) =>
  denied.some((rule) => inside(same(path), same(rule)) || inside(same(rule), same(path)));

/** Whether `child` is `parent` or inside it, in one spelling. */
export const within = (parent: string, child: string) => inside(same(parent), same(child));

/** Why a real path cannot be granted, judged on the path alone. */
export const pathRefusal = (asked: string, rules: PathRules): string | null => {
  if (!isAbsolute(asked) || parse(asked).root === asked) return "A whole disk cannot be shared.";
  const path = same(asked);
  if (inside(path, same(rules.home)))
    return "The home folder cannot be shared as a whole. Name what is inside it.";
  if (touchesDenied(asked, rules.denied))
    return "Credentials and the app’s own data are never shared with commands.";
  return null;
};

/** Readable paths, held to the same rules whether asked for now or loaded from disk. */
export const loadPathGrants = (directory: string, rules: PathRules): Promise<PathGrants> =>
  loadScopedGrants(directory, "path-grants.json", (path) => pathRefusal(path, rules) === null);

const unchecked = (path: string) =>
  new Error(
    `${path} cannot be checked for linked credentials. Let this app list it (chmod u+rx) to run commands.`,
  );

/** macOS's data volume also holds the system's writable folders under a second spelling. */
const DATA_VOLUME = "/System/Volumes/Data/";

/** A real path in each spelling the system keeps for it: a deny holds only the one it names. */
export const spellings = (real: string) =>
  process.platform === "darwin" && real.startsWith(DATA_VOLUME)
    ? [real, `/${real.slice(DATA_VOLUME.length)}`]
    : [real];

/**
 * Where links in credential trees lead: the trees are walked whole (they are small), linked
 * folders followed once each, so a key kept elsewhere and linked into ~/.ssh is a credential
 * at its real path too.
 */
export const credentialLinks = async (roots: readonly string[], budget = 20_000) => {
  const found = new Set<string>();
  const seen = new Set<string>();
  for (const root of roots) {
    // Breadth first, each root its own budget, a level's links before its folders: a link near
    // the root (~/.kube/config) is found before a large cache below it (~/.kube/cache) could
    // use the budget up.
    let left = budget;
    let level = [root];
    while (level.length > 0 && left > 0) {
      const links: string[] = [];
      const folders: string[] = [];
      for (const path of level) {
        left -= 1;
        if (left < 0) break;
        const real = await realpath(path).catch((error: NodeJS.ErrnoException) => {
          // A link into a folder the app may not enter leads nowhere it can see: unchecked.
          if (error.code === "EACCES" || error.code === "EPERM")
            throw new Error(
              `${path} leads where this app cannot look. Let it read the folders on the way to run commands.`,
            );
          return null;
        });
        if (!real || seen.has(real)) continue;
        seen.add(real);
        if (real !== path) for (const spelling of spellings(real)) found.add(spelling);
        const entries = await readdir(real, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            // A folder that may be entered but not listed could hold links nobody can see:
            // unchecked, not empty.
            if (error.code === "EACCES" || error.code === "EPERM") throw unchecked(real);
            return [];
          },
        );
        for (const entry of entries)
          if (entry.isSymbolicLink()) links.push(join(real, entry.name));
          else if (entry.isDirectory()) folders.push(join(real, entry.name));
      }
      level = [...links, ...folders];
    }
  }
  return [...found];
};
