import { Worker, type WorkerOptions } from "node:worker_threads";
import { Effect } from "effect";
import { DesktopError, LIMITS } from "@chat/desktop-rpc";
import type { SearchMatch } from "@chat/desktop-rpc";

// Embedded so Electron's bundled main needs no separately packaged worker file.
// Only the worker constructs or runs the model's JavaScript regexp.
const MATCHER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let regex;
try {
  regex = new RegExp(workerData.pattern);
} catch {
  parentPort.postMessage({ type: "bad-pattern" });
}
if (regex) {
  parentPort.on("message", ({ text, limit }) => {
    parentPort.postMessage({ type: "matching" });
    const matches = [];
    const lines = text.split("\\n");
    let truncated = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!regex.test(line)) continue;
      matches.push({ line: index + 1, text: line.slice(0, workerData.matchChars) });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    parentPort.postMessage({ type: "result", matches, truncated });
  });
  parentPort.postMessage({ type: "ready" });
}
`;

type MatchResult = { matches: Omit<SearchMatch, "path">[]; truncated: boolean };
type WorkerMessage =
  | { type: "ready" | "matching" | "bad-pattern" }
  | ({ type: "result" } & MatchResult);
export type RegexMatcher = (
  text: string,
  limit: number,
) => Effect.Effect<MatchResult, DesktopError>;
interface MatcherOptions {
  timeoutMs?: number;
  createWorker?: (source: string, options: WorkerOptions) => Worker;
}

/** One call owns one matcher, one parent deadline, and an acknowledged worker exit. */
export const withRegexMatcher = <A, E, R>(
  pattern: string,
  use: (match: RegexMatcher) => Effect.Effect<A, E, R>,
  options: MatcherOptions = {},
): Effect.Effect<A, E | DesktopError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const worker = (options.createWorker ?? ((source, config) => new Worker(source, config)))(
          MATCHER_SOURCE,
          {
            eval: true,
            // No ambient launch options, preloads or credentials in the matching worker.
            execArgv: [],
            env: {},
            workerData: { pattern, matchChars: LIMITS.matchChars },
          },
        );
        const ready = Promise.withResolvers<void>();
        let pending: ReturnType<typeof Promise.withResolvers<MatchResult>> | undefined;
        let failure: DesktopError | undefined;
        let stopping: Promise<number> | undefined;
        const fail = (error: DesktopError) => {
          failure ??= error;
          ready.reject(failure);
          pending?.reject(failure);
        };
        const onMessage = (message: WorkerMessage) => {
          if (message.type === "ready") ready.resolve();
          else if (message.type === "bad-pattern")
            fail(
              new DesktopError({
                reason: "bad-pattern",
                message: `${pattern} is not a valid regular expression.`,
              }),
            );
          else if (message.type === "result") {
            pending?.resolve({ matches: message.matches, truncated: message.truncated });
            pending = undefined;
          }
        };
        const onError = () =>
          fail(new DesktopError({ reason: "failed", message: "The search worker failed." }));
        const onExit = () => {
          if (!stopping) onError();
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.on("exit", onExit);
        const timeoutMs = options.timeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          fail(
            new DesktopError({
              reason: "timed-out",
              message: "The search took too long and was stopped.",
            }),
          );
          stopping ??= worker.terminate();
        }, timeoutMs);
        const match: RegexMatcher = (text, limit) =>
          Effect.tryPromise({
            try: async () => {
              if (failure) throw failure;
              if (pending) throw new Error("Search matches must run in order.");
              pending = Promise.withResolvers<MatchResult>();
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker threads have no target origin.
              worker.postMessage({ text, limit });
              return pending.promise;
            },
            catch: (cause) =>
              cause instanceof DesktopError
                ? cause
                : new DesktopError({ reason: "failed", message: "Could not search the file." }),
          });
        const cleanup = async () => {
          clearTimeout(timer);
          stopping ??= worker.terminate();
          await stopping;
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        return { ready: ready.promise, match, cleanup };
      },
      catch: () =>
        new DesktopError({ reason: "failed", message: "Could not start the search worker." }),
    }),
    ({ ready, match }) =>
      Effect.tryPromise({
        try: () => ready,
        catch: (cause) =>
          cause instanceof DesktopError
            ? cause
            : new DesktopError({ reason: "failed", message: "Could not start the search worker." }),
      }).pipe(Effect.andThen(() => use(match))),
    ({ cleanup }) => Effect.promise(cleanup),
  );
