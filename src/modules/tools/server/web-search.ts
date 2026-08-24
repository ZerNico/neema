import { Context, Effect, Layer, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import {
  WebSearchParams,
  WebToolResult as WebToolResultSchema,
  type Source,
  type WebToolFailure,
  type WebToolResult as Result,
} from "../schema.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, type SearchHit } from "./search.ts";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { canonicalUserUrl } from "./user-urls.ts";

export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()("ToolUnavailable", {
  tool: Schema.String,
  reason: Schema.String,
}) {}

const MAX_MERGED_RESULTS = 20;

export { WebToolResult } from "../schema.ts";

export const webSearchTool = Tool.make("web_search", {
  description:
    "Search the web with one or more queries. Returns titles, URLs, and snippets, not page content. " +
    "Use read_url with the most relevant result URLs when the answer needs full-page evidence.",
  parameters: WebSearchParams,
  success: WebToolResultSchema,
  // Handler failures become tool results the model can react to.
  failureMode: "return",
});

export type WebSearchHandler = (params: WebSearchParams) => Effect.Effect<Result>;

interface SearchOutcome {
  readonly query: string;
  readonly hits: ReadonlyArray<SearchHit>;
  readonly error: string | null;
}

const uniqueQueries = (queries: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of queries) {
    const query = raw.trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    result.push(query);
  }
  return result;
};

const mergeRoundRobin = (outcomes: ReadonlyArray<SearchOutcome>): SearchHit[] => {
  const buckets = outcomes.map((outcome) =>
    outcome.hits.flatMap((hit) => {
      const canonical = canonicalUserUrl(hit.url);
      return canonical ? [{ ...hit, url: canonical }] : [];
    }),
  );
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  const longest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  for (let rank = 0; rank < longest && merged.length < MAX_MERGED_RESULTS; rank++) {
    for (const bucket of buckets) {
      const hit = bucket[rank];
      if (!hit || seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
      if (merged.length >= MAX_MERGED_RESULTS) break;
    }
  }
  return merged;
};

// Builds the ready-to-use handler for a generation run. Loads config once so a
// run keeps a stable snapshot even if an admin edits the tool mid-stream.
export class WebSearchExecutor extends Context.Service<
  WebSearchExecutor,
  {
    /** The generation's shared indexer keeps citation numbers unique across tools. */
    handler(
      indexer: SourceIndexer,
      authority: UrlAuthority,
    ): Effect.Effect<WebSearchHandler, ToolUnavailable>;
    // Cheap check used by ChatService validation + composer availability.
    availability(): Effect.Effect<{ configured: boolean; enabled: boolean }>;
  }
>()("chat/tools/WebSearchExecutor") {
  static readonly layer = Layer.effect(
    WebSearchExecutor,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const backend = yield* SearchBackend;

      const makeHandler = Effect.fn("WebSearchExecutor.handler")(function* (
        indexer: SourceIndexer,
        authority: UrlAuthority,
      ) {
        const tool = yield* repo.getWebSearch();
        if (!tool) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "disabled" });
        }
        const { config, secret } = tool;
        const connection = { baseUrl: config.baseUrl, secret };

        const handler = Effect.fnUntraced(function* (params: WebSearchParams) {
          const queries = uniqueQueries(params.queries);
          if (queries.length === 0) {
            return {
              ok: false,
              targets: [],
              resultCount: 0,
              pagesFetched: 0,
              results: [],
              failures: [{ target: "", error: "at least one non-empty query is required" }],
              error: "at least one non-empty query is required",
            } satisfies Result;
          }

          const outcomes = yield* Effect.forEach(
            queries,
            (query): Effect.Effect<SearchOutcome> =>
              backend
                .search(connection, {
                  query,
                  maxResults: config.maxResults,
                  ...(params.timeRange !== undefined ? { timeRange: params.timeRange } : {}),
                  ...(params.language !== undefined ? { language: params.language } : {}),
                })
                .pipe(
                  Effect.map((hits) => ({ query, hits, error: null })),
                  Effect.catchTag("SearchBackendError", (error) =>
                    Effect.succeed({ query, hits: [], error: error.message }),
                  ),
                ),
            { concurrency: 3 },
          );

          const hits = mergeRoundRobin(outcomes);
          const failures: WebToolFailure[] = outcomes.flatMap((outcome) =>
            outcome.error ? [{ target: outcome.query, error: outcome.error }] : [],
          );
          const sources: Source[] = hits.map((hit) => {
            authority.allow(hit.url);
            return {
              index: indexer.indexFor(hit.url),
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              read: false,
            };
          });
          const ok = failures.length < outcomes.length;

          return {
            ok,
            targets: queries,
            resultCount: hits.length,
            pagesFetched: 0,
            results: sources.map(({ index, title, url, snippet }) => ({
              index,
              title,
              url,
              snippet,
            })),
            failures,
            sources,
            ...(!ok
              ? {
                  error: failures
                    .map((failure) => `${failure.target}: ${failure.error}`)
                    .join("; "),
                }
              : {}),
          } satisfies Result;
        });

        return handler as WebSearchHandler;
      });

      const availability = Effect.fn("WebSearchExecutor.availability")(function* () {
        const tool = yield* repo.getTool("web_search");
        return { configured: tool !== null, enabled: tool?.enabled ?? false };
      });

      return WebSearchExecutor.of({ handler: makeHandler, availability });
    }),
  );
}
