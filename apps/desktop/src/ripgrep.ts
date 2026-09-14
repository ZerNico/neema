import { Effect } from "effect";
import { runOwnedProcess } from "./process.ts";
import type { SearchMatch } from "@chat/desktop-rpc";
import { LIMITS } from "@chat/desktop-rpc";

/**
 * ripgrep, when the machine has it.
 *
 * Not bundled: that would be a native binary per platform inside the app,
 * which on macOS has to be signed and notarised or Gatekeeper refuses it on
 * first launch, and that drags the whole packaging story in. Homebrew users
 * get the fast path for free; everyone else gets the walker in `walk.ts`,
 * which is correct on the same cases and only slower on very large trees.
 *
 * The two honour the same rules on purpose: `.gitignore` respected even
 * outside a git checkout, `.git` skipped, hidden files included, symlinks
 * not followed, binary files skipped in search. A result must not depend
 * on which backend answered.
 */

const OUTPUT_BYTES = 8 * 1024 * 1024;

/** Resolved once per process; `rg` does not appear mid-session. */
let available: Promise<boolean> | undefined;

export const ripgrepAvailable = (): Promise<boolean> => {
  available ??= Effect.runPromise(
    runOwnedProcess({
      program: "rg",
      args: ["--version"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 3_000,
    }),
  ).then(
    (result) => result.code === 0,
    () => false,
  );
  return available;
};

const RG_TREE = ["--hidden", "--no-require-git", "--glob", "!.git", "--glob", "!.git/**"] as const;

const rg = (args: readonly string[], cwd: string) =>
  runOwnedProcess({
    program: "rg",
    args: [...args],
    cwd,
    env: process.env,
    timeoutMs: 30_000,
    outputChars: OUTPUT_BYTES,
  }).pipe(
    Effect.map(({ code, stdout }) => ({ code, stdout })),
    Effect.catch(() => Effect.succeed({ code: 2, stdout: "" })),
  );

/** Paths under `root` matching a glob, newest first. `null` when rg is not present. */
export const findWithRipgrep = (
  root: string,
  glob: string | undefined,
): Effect.Effect<{ paths: string[]; truncated: boolean } | null> =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(ripgrepAvailable))) return null;
    // `--sortr modified` is what the walker does by hand; `-g` without a slash
    // matches at any depth, the same rule `globToRegExp` applies. `--hidden`
    // matches the walker, which lists dotfiles other than `.git`.
    const { stdout } = yield* rg(
      [
        "--files",
        ...RG_TREE,
        "--sortr",
        "modified",
        ...(glob ? ["--glob", glob] : []),
        "--",
        ".",
      ],
      root,
    );
    const all = stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (line.startsWith("./") ? line.slice(2) : line));
    return {
      paths: all.slice(0, LIMITS.foundPaths),
      truncated: all.length > LIMITS.foundPaths,
    };
  });

interface RgMatch {
  readonly type: "match";
  readonly data: {
    readonly path: { readonly text?: string };
    readonly line_number: number | null;
    readonly lines: { readonly text?: string };
  };
}
interface RgSummary {
  readonly type: "summary";
  readonly data: { readonly stats: { readonly searches: number } };
}

const parseEvent = (line: string): RgMatch | RgSummary | null => {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type === "match" || parsed.type === "summary"
      ? (parsed as RgMatch | RgSummary)
      : null;
  } catch {
    return null;
  }
};

/** JSON events from one `rg --json` run. Kept parsing after the match cap so the summary still counts. */
export const parseRipgrepSearchOutput = (
  stdout: string,
): { matches: SearchMatch[]; filesSearched: number; truncated: boolean } => {
  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let truncated = false;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = parseEvent(line);
    if (!event) continue;
    if (event.type === "summary") {
      filesSearched = event.data.stats.searches;
      continue;
    }
    if (matches.length >= LIMITS.matches) {
      truncated = true;
      continue;
    }
    const path = event.data.path.text ?? "";
    const text = (event.data.lines.text ?? "").replace(/\r?\n$/, "");
    matches.push({
      path: path.startsWith("./") ? path.slice(2) : path,
      line: event.data.line_number ?? 0,
      text: text.length > LIMITS.matchChars ? text.slice(0, LIMITS.matchChars) : text,
    });
  }
  return { matches, filesSearched, truncated };
};

/** Matching lines under `root`. `null` when rg is not present. */
export const searchWithRipgrep = (
  root: string,
  pattern: string,
  glob: string | undefined,
): Effect.Effect<
  { matches: SearchMatch[]; filesSearched: number; truncated: boolean } | null,
  { readonly reason: "bad-pattern" }
> =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(ripgrepAvailable))) return null;
    const args = [
      "--json",
      // A folder that is not a git checkout still has its .gitignore honoured,
      // as the walker does; rg's default only reads it inside a repo.
      ...RG_TREE,
      "--regexp",
      pattern,
      // One more than the cap, so truncation can be told from an exact fit.
      "--max-count",
      String(LIMITS.matches + 1),
      ...(glob ? ["--glob", glob] : []),
      "--",
      ".",
    ];
    const { code, stdout } = yield* rg(args, root);
    // 0 matches, 1 none; 2 is a real error, of which a bad regex is the one a
    // caller can do something about.
    if (code === 2) return yield* Effect.fail({ reason: "bad-pattern" as const });
    return parseRipgrepSearchOutput(stdout);
  });
