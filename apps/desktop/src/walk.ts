import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Walks a folder the way a developer expects a search to: `.gitignore` is
 * honoured at every level and `.git` itself is never entered. Without this,
 * one `node_modules` swallows every result cap and the model sees nothing it
 * asked for.
 *
 * Symlinks are not followed. The containment check proves the folder root;
 * a link inside it can still point out, and a walk that followed it would
 * read the host through the back door the resolver closed at the front.
 */

const ALWAYS_SKIPPED = new Set([".git"]);

export interface WalkedFile {
  /** POSIX-style, relative to the root. */
  readonly relative: string;
  readonly absolute: string;
  readonly mtimeMs: number;
}

const toPosix = (path: string) => (sep === "/" ? path : path.split(sep).join("/"));

const loadIgnore = async (dir: string): Promise<Ignore | null> => {
  let rules: string;
  try {
    rules = await readFile(join(dir, ".gitignore"), "utf8");
  } catch {
    return null;
  }
  return ignore().add(rules);
};

/**
 * Every file under `root`, ignore rules applied. Bounded by `limit` files
 * visited (not returned), so a huge folder with a broken `.gitignore` still
 * answers instead of walking forever.
 */
export const walkFiles = async (
  root: string,
  limit: number,
  keep: (relativePath: string) => boolean = () => true,
): Promise<{ files: WalkedFile[]; truncated: boolean }> => {
  const files: WalkedFile[] = [];
  let visited = 0;
  let truncated = false;

  // Each directory's matcher is checked against paths relative to *that*
  // directory, which is how nested `.gitignore` files scope in git.
  const visit = async (dir: string, chain: Array<{ base: string; ig: Ignore }>) => {
    const own = await loadIgnore(dir);
    const matchers = own ? [...chain, { base: dir, ig: own }] : chain;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      const isDir = entry.isDirectory();
      const ignored = matchers.some(({ base, ig }) => {
        const rel = toPosix(relative(base, absolute));
        return ig.ignores(isDir ? `${rel}/` : rel);
      });
      if (ignored) continue;
      if (isDir) {
        await visit(absolute, matchers);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (visited > limit) {
        truncated = true;
        return;
      }
      const rel = toPosix(relative(root, absolute));
      if (!keep(rel)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(absolute)).mtimeMs;
      } catch {
        continue;
      }
      files.push({ relative: rel, absolute, mtimeMs });
    }
  };

  await visit(root, []);
  return { files, truncated };
};

/**
 * Glob to regular expression, the subset every agent's find tool speaks:
 * `**` any depth, `*` within a segment, `?` one character, `{a,b}` choice.
 * A pattern with no slash matches at any depth, as it would in `.gitignore`.
 */
export const globToRegExp = (pattern: string): RegExp => {
  const anywhere = !pattern.includes("/");
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` eats the trailing slash too, so `**/x` also matches a root `x`.
        const slash = pattern[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${pattern
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replaceAll(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
          .join("|")})`;
        i = close;
      }
    } else out += ch.replaceAll(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${out}$`);
};
