import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = join(import.meta.dirname, "..");

/**
 * The server functions anyone may call, signed in or not, each for its page
 * before sign-in. Every other one must name a `require…` middleware.
 */
const PUBLIC = new Set([
  "modules/auth/server/signup-functions.ts#getSignInOptions",
  "modules/auth/server/signup-functions.ts#getNeedsSetup",
  "modules/auth/server/functions.ts#getMe",
]);

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });

/** Each `const name = createServerFn(…)` with the middleware its chain names, if any. */
const serverFunctions = () =>
  sources(SOURCE).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/const\s+(\w+)\s*=\s*createServerFn\(/g)].map((match) => {
      const rest = text.slice(match.index + match[0].length);
      const end = rest.search(/\n(?:export\s+)?(?:const|function|async function|type|interface)\s/);
      const chain = end === -1 ? rest : rest.slice(0, end);
      return {
        name: `${relative(SOURCE, path)}#${match[1]}`,
        guarded: /\.middleware\(\[[^\]]*\brequire\w+/.test(chain),
      };
    });
  });

describe("server function authentication", () => {
  it("guards every server function but the public few", () => {
    const found = serverFunctions();
    // A scan that found nothing would pass vacuously.
    expect(found.length).toBeGreaterThan(200);
    expect(found.filter((fn) => !fn.guarded && !PUBLIC.has(fn.name)).map((fn) => fn.name)).toEqual(
      [],
    );
    // A public one that gained a guard, or went away, leaves the list.
    const unguarded = new Set(found.filter((fn) => !fn.guarded).map((fn) => fn.name));
    expect([...PUBLIC].filter((name) => !unguarded.has(name))).toEqual([]);
  });
});
