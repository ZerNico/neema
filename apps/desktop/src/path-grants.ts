import { realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, sep } from "node:path";
import { loadScopedGrants, type ScopedGrants } from "./scoped-grants.ts";

/**
 * Paths outside the attached folders that commands may read, because the
 * person said so: one exact file or folder, for the answer that asked, the
 * chat, or every chat. Read only; a writable place is an attached folder.
 */
export type PathGrants = ScopedGrants;

const inside = (parent: string, child: string) => {
  const rest = relative(parent, child);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

export interface PathRules {
  readonly home: string;
  /** Credential paths and the permission store: never granted, whatever is asked. */
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
  const refusal = pathRefusal(real, rules);
  return refusal ? { ok: false, reason: refusal } : { ok: true, path: real };
};

/** Why a real path cannot be granted, judged on the path alone. */
export const pathRefusal = (path: string, rules: PathRules): string | null => {
  if (!isAbsolute(path) || parse(path).root === path) return "A whole disk cannot be shared.";
  if (inside(path, rules.home))
    return "The home folder cannot be shared as a whole. Name what is inside it.";
  if (rules.denied.some((denied) => inside(denied, path) || inside(path, denied)))
    return "Credentials and permission settings are never shared with commands.";
  return null;
};

/** Readable paths, held to the same rules whether asked for now or loaded from disk. */
export const loadPathGrants = (directory: string, rules: PathRules): Promise<PathGrants> =>
  loadScopedGrants(directory, "path-grants.json", (path) => pathRefusal(path, rules) === null);
