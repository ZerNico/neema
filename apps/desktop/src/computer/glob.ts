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

/**
 * The folder a file matched through, or the file itself: `*extracted*` finds
 * `DVR/extracted_images/frame.png` by its folder, not only a file whose own name contains
 * "extracted". Undefined when nothing on the path matches.
 */
export const matchedPrefix = (matcher: RegExp, path: string): string | undefined => {
  let rest = path;
  let matched: string | undefined;
  for (;;) {
    if (matcher.test(rest)) matched = rest;
    const slash = rest.lastIndexOf("/");
    if (slash === -1) return matched;
    rest = rest.slice(0, slash);
  }
};
