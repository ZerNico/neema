import { Effect } from "effect";
import { runOwnedProcess } from "./process.ts";
import type { SearchMatch } from "@chat/desktop-rpc";
import { DesktopError, LIMITS } from "@chat/desktop-rpc";

/**
 * ripgrep, when the machine has it.
 *
 * Not bundled: that would be a native binary per platform inside the app,
 * which on macOS has to be signed and notarised or Gatekeeper refuses it on
 * first launch, and that drags the whole packaging story in. A machine with
 * `rg` on the shell's PATH gets the fast path; everyone else gets the walker
 * in `walk.ts`, which is slower on very large trees.
 *
 * The two share the rules that matter for containment and for what the
 * model sees: `.gitignore` honoured even outside a git checkout, `.git`
 * skipped, hidden files included, symlinks never followed, binary files
 * skipped in search. They are not identical. rg also reads `.ignore`,
 * `.rgignore` and a repository's excludes, gives a deeper `.gitignore`
 * precedence where the walker ORs them, and speaks its own glob dialect
 * (`[abc]`, `!x`); the walker's `globToRegExp` treats those literally.
 * The caller picks the backend once per handler call; the same folder
 * searched on two machines can therefore differ at those edges.
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

/**
 * `--no-config` first: a user's `RIPGREP_CONFIG_PATH` could add `--follow`
 * and walk a symlink out of the folder, or `--no-ignore` and read what the
 * folder asked to have skipped. `--no-require-git` makes a `.gitignore`
 * count outside a checkout, as the walker does.
 */
const RG_TREE = ["--no-config", "--hidden", "--no-require-git", "--glob", "!.git"] as const;

const RG_TIMEOUT_MS = 30_000;

const rg = (args: readonly string[], cwd: string) =>
  runOwnedProcess({
    program: "rg",
    args: [...args],
    cwd,
    env: process.env,
    timeoutMs: RG_TIMEOUT_MS,
    outputChars: OUTPUT_BYTES,
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new DesktopError({ reason: "failed", message: `Could not run rg: ${String(cause)}` }),
      ),
    ),
    Effect.flatMap((result) =>
      result.timedOut
        ? Effect.fail(
            new DesktopError({
              reason: "timed-out",
              message: `The search was still running after ${RG_TIMEOUT_MS / 1000}s and was stopped.`,
            }),
          )
        : Effect.succeed(result),
    ),
  );

/**
 * rg exits 2 for any error, including one unreadable file in a tree that
 * otherwise searched fine, so the code alone cannot tell a bad pattern from a
 * partial result. Output that parsed is a result; no output and a parse error
 * on stderr is the pattern; anything else is reported as what rg said.
 */
const explainFailure = (stderr: string, pattern: string): DesktopError => {
  const firstLine = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
  if (/regex parse error|error parsing glob|unrecognized escape|invalid glob/i.test(stderr))
    return new DesktopError({ reason: "bad-pattern", message: `Could not read ${pattern}.` });
  return new DesktopError({
    reason: "failed",
    message: firstLine ? `The search failed: ${firstLine.slice(0, 300)}` : "The search failed.",
  });
};

/** Paths under `root` matching a glob, newest first. */
export const findWithRipgrep = (
  root: string,
  glob: string | undefined,
): Effect.Effect<{ paths: string[]; truncated: boolean }, DesktopError> =>
  Effect.gen(function* () {
    // `--sortr modified` is what the walker does by hand; `-g` without a slash
    // matches at any depth, the same rule `globToRegExp` applies.
    const { code, stdout, stderr } = yield* rg(
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
    if (code === 2 && stdout === "") return yield* Effect.fail(explainFailure(stderr, glob ?? "*"));
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

/**
 * JSON events from one `rg --json` run. Parsing continues past the match cap
 * so the summary still counts files. A run whose output hit the byte cap has
 * lost its summary and possibly a torn last line, which is reported as
 * truncated rather than as a smaller search.
 */
export const parseRipgrepSearchOutput = (
  stdout: string,
): { matches: SearchMatch[]; filesSearched: number; truncated: boolean; summarised: boolean } => {
  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let truncated = false;
  let summarised = false;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const event = parseEvent(line);
    if (!event) continue;
    if (event.type === "summary") {
      filesSearched = event.data.stats.searches;
      summarised = true;
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
  return { matches, filesSearched, truncated: truncated || !summarised, summarised };
};

/** Matching lines under `root`. */
export const searchWithRipgrep = (
  root: string,
  pattern: string,
  glob: string | undefined,
): Effect.Effect<
  { matches: SearchMatch[]; filesSearched: number; truncated: boolean },
  DesktopError
> =>
  Effect.gen(function* () {
    const args = [
      "--json",
      ...RG_TREE,
      "--regexp",
      pattern,
      // Per file, not in total: rg has no total cap. This keeps one file with
      // thousands of hits from filling the output budget on its own.
      "--max-count",
      String(LIMITS.matches + 1),
      ...(glob ? ["--glob", glob] : []),
      "--",
      ".",
    ];
    const { code, stdout, stderr } = yield* rg(args, root);
    const parsed = parseRipgrepSearchOutput(stdout);
    // 0 matches, 1 none. 2 with a summary is a partial search (some file
    // could not be read) and is still an answer.
    if (code === 2 && !parsed.summarised) return yield* Effect.fail(explainFailure(stderr, pattern));
    return { matches: parsed.matches, filesSearched: parsed.filesSearched, truncated: parsed.truncated };
  });
