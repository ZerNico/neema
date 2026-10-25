import type { WebExecutionPolicy } from "./execution-policy.ts";
import { Context, Effect, Layer } from "effect";
import { Tool } from "effect/ai";
import {
  UrlReadParams,
  WebToolResult,
  type PageStatus,
  type WebSource,
  type WebToolFailure,
  type WebToolResult as Result,
} from "../schema.ts";
import { PageExtractor, type ExtractedPage } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { canonicalUserUrl } from "./user-urls.ts";
import { ToolUnavailable } from "./web-search.ts";

const MAX_CHARS_ACROSS_URLS = 60_000;
const DISALLOWED_REASON =
  "read_url can only open a URL from a user message or from this conversation's search results";

export const urlReaderTool = Tool.make("read_url", {
  description:
    "Open and read one or more URLs from user messages or web_search results. Fetches the pages " +
    "in parallel and returns their main content as markdown; PDFs, JSON, CSV and Markdown files " +
    "are read too. Never invent a URL.",
  parameters: UrlReadParams,
  success: WebToolResult,
  failureMode: "return",
});

/** The first markdown-ish line trimmed to snippet length for the source list. */
const snippetOf = (content: string): string => {
  const line = content
    .split("\n")
    .map((value) => value.replace(/^[#>\-*\s]+/, "").trim())
    .find((value) => value.length > 0);
  return (line ?? "").slice(0, 200);
};

const uniqueTargets = (urls: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of urls) {
    const target = raw.trim();
    const key = canonicalUserUrl(target) ?? target;
    if (!target || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
};

const formatFailures = (failures: ReadonlyArray<WebToolFailure>): string =>
  failures.map((failure) => `${failure.target} (${failure.error})`).join("; ");

const truncateAtCodePoint = (value: string, maxChars: number): string => {
  let result = "";
  for (const codePoint of value) {
    if (result.length + codePoint.length > maxChars) break;
    result += codePoint;
  }
  return result;
};

type ReadOutcome =
  | { readonly target: string; readonly extracted: ExtractedPage; readonly error: null }
  | { readonly target: string; readonly extracted: null; readonly error: string };

export class UrlReaderExecutor extends Context.Service<
  UrlReaderExecutor,
  {
    /** The generation's shared indexer keeps citation numbers unique across tools. */
    handler(
      indexer: SourceIndexer,
      authority: UrlAuthority,
      policy?: WebExecutionPolicy,
      /** The person whose answer this is, for anything a read bills, such as scanned PDF pages. */
      owner?: string,
    ): Effect.Effect<
      (
        params: UrlReadParams,
        ctx: { preliminary: (result: Result) => Effect.Effect<void> },
      ) => Effect.Effect<Result>,
      ToolUnavailable
    >;
    availability(): Effect.Effect<{ configured: boolean; enabled: boolean }>;
  }
>()("chat/tools/UrlReaderExecutor") {
  static readonly layer = Layer.effect(
    UrlReaderExecutor,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const extractor = yield* PageExtractor;

      const makeHandler = Effect.fn("UrlReaderExecutor.handler")(function* (
        indexer: SourceIndexer,
        authority: UrlAuthority,
        policy?: WebExecutionPolicy,
        owner?: string,
      ) {
        const tool = yield* repo.getUrlReader();
        if (!tool) {
          return yield* new ToolUnavailable({ tool: "read_url", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "read_url", reason: "disabled" });
        }
        const { config } = tool;

        return Effect.fnUntraced(function* (
          params: UrlReadParams,
          ctx: { preliminary: (result: Result) => Effect.Effect<void> },
        ) {
          if (policy && !policy.admit("read", params.urls.length))
            return {
              ok: false,
              targets: [...params.urls],
              resultCount: 0,
              pagesFetched: 0,
              results: [],
              failures: [],
              error: "Research web budget or exploration deadline reached.",
            } satisfies Result;
          const targets = uniqueTargets(params.urls);
          const entries = targets.map((target, index) => ({
            target,
            index,
            canonical: authority.resolve(target),
          }));
          const pages: PageStatus[] = entries.map((entry) =>
            entry.canonical
              ? { url: entry.canonical, status: "pending" }
              : { url: entry.target, status: "error", error: DISALLOWED_REASON },
          );
          const allowed = entries.filter(
            (entry): entry is typeof entry & { canonical: string } => entry.canonical !== null,
          );
          const refused: WebToolFailure[] = entries.flatMap((entry) =>
            entry.canonical ? [] : [{ target: entry.target, error: DISALLOWED_REASON }],
          );

          if (allowed.length === 0) {
            return {
              ok: false,
              targets,
              resultCount: 0,
              pagesFetched: 0,
              results: [],
              failures: refused,
              pages,
              error: formatFailures(refused),
            } satisfies Result;
          }

          const progress = () =>
            ctx.preliminary({
              ok: true,
              targets,
              resultCount: 0,
              pagesFetched: 0,
              results: [],
              failures: refused,
              pages: structuredClone(pages),
            });
          yield* progress();

          const outcomes = yield* Effect.forEach(
            allowed,
            (entry): Effect.Effect<ReadOutcome> =>
              Effect.gen(function* () {
                pages[entry.index] = { url: entry.canonical, status: "reading" };
                yield* progress();
                return yield* extractor
                  .extract({
                    url: entry.canonical,
                    charCap: config.perPageCharCap,
                    ...(owner ? { owner } : {}),
                  })
                  .pipe(
                    (effect) => (policy ? policy.run(effect) : effect),
                    Effect.map((extracted): ReadOutcome => {
                      const title = extracted.title ?? new URL(extracted.url).hostname;
                      pages[entry.index] = { url: extracted.url, title, status: "done" };
                      return { target: entry.target, extracted, error: null };
                    }),
                    Effect.catchTag("PageExtractionError", (error) => {
                      pages[entry.index] = {
                        url: entry.canonical,
                        status: "error",
                        error: error.message,
                      };
                      return Effect.succeed<ReadOutcome>({
                        target: entry.target,
                        extracted: null,
                        error: error.message,
                      });
                    }),
                    Effect.tap(() => progress()),
                  );
              }),
            { concurrency: 3 },
          );

          const successful = outcomes.filter(
            (outcome): outcome is Extract<ReadOutcome, { error: null }> => outcome.error === null,
          );
          const extractionFailures: WebToolFailure[] = outcomes.flatMap((outcome) =>
            outcome.error ? [{ target: outcome.target, error: outcome.error }] : [],
          );
          const failures = [...refused, ...extractionFailures];
          let remainingChars = MAX_CHARS_ACROSS_URLS;
          let remainingPages = successful.length;
          const sources: WebSource[] = [];
          const results: Array<Result["results"][number]> = [];
          for (const { extracted } of successful) {
            authority.allow(extracted.url);
            const title = extracted.title ?? new URL(extracted.url).hostname;
            const index = indexer.indexFor(extracted.url);
            const fairShare = Math.ceil(remainingChars / remainingPages);
            const truncatedAcrossBatch = extracted.content.length > fairShare;
            const marker = "\n\n[content truncated]";
            const content = truncatedAcrossBatch
              ? `${truncateAtCodePoint(
                  extracted.content,
                  Math.max(0, fairShare - marker.length),
                )}${marker}`
              : extracted.content;
            remainingChars = Math.max(0, remainingChars - content.length);
            remainingPages -= 1;
            const snippet = snippetOf(content);
            sources.push({
              kind: "web" as const,
              index,
              url: extracted.url,
              title,
              snippet,
              read: true,
            });
            results.push({
              index,
              title,
              url: extracted.url,
              snippet,
              content,
              ...(extracted.truncated || truncatedAcrossBatch ? { truncated: true } : {}),
            });
          }
          const ok = results.length > 0;

          return {
            ok,
            targets,
            resultCount: results.length,
            pagesFetched: results.length,
            results,
            failures,
            pages,
            ...(sources.length > 0 ? { sources } : {}),
            ...(failures.length > 0 ? { error: formatFailures(failures) } : {}),
          } satisfies Result;
        });
      });

      const availability = Effect.fn("UrlReaderExecutor.availability")(function* () {
        const tool = yield* repo.getUrlReader();
        return { configured: tool !== null, enabled: tool?.enabled ?? false };
      });

      return UrlReaderExecutor.of({ handler: makeHandler, availability });
    }),
  );
}
