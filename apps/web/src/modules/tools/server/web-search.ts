import type { WebExecutionPolicy } from "./execution-policy.ts";
import { Context, Effect, Layer, Schema, type Scope } from "effect";
import { Tool } from "effect/ai";
import {
  RESEARCH_SEARCH_BUDGET,
  WebSearchParams,
  WebToolResult as WebToolResultSchema,
  type WebSource,
  type WebToolFailure,
  type WebToolResult as Result,
} from "../schema.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchProviders, type SearchFailed } from "./search-providers/chain.ts";
import type { ImageHit, SearchHit } from "./search-providers/types.ts";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { canonicalUserUrl } from "./user-urls.ts";
import { makeGenerationCache } from "./generation-cache.ts";

export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()("ToolUnavailable", {
  tool: Schema.String,
  reason: Schema.String,
}) {}

const MAX_MERGED_RESULTS = 20;

const cacheKey = (query: string, params: WebSearchParams) =>
  JSON.stringify([query, params.timeRange ?? null, params.language ?? null]);

export { WebToolResult } from "../schema.ts";

export const webSearchTool = Tool.make("web_search", {
  description:
    "Search the web with one or more queries. Returns titles, URLs, and snippets, not page content. " +
    "When read_url is available, use it with the most relevant result URLs when the answer needs full-page evidence.",
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

/**
 * Builds the ready-to-use handler for a generation run. Loads config once so a
 * run keeps a stable snapshot even if an admin edits the tool mid-stream.
 */
export class WebSearchExecutor extends Context.Service<
  WebSearchExecutor,
  {
    /** The generation's shared indexer keeps citation numbers unique across tools. */
    handler(
      indexer: SourceIndexer,
      authority: UrlAuthority,
      policy?: WebExecutionPolicy,
    ): Effect.Effect<WebSearchHandler, ToolUnavailable, Scope.Scope>;
    /** Read once at research start; an active run keeps its captured allowance. */
    researchSearchLimit(): Effect.Effect<number>;
    /**
     * Image search across the configured providers that have it. Fails with
     * ToolUnavailable when web search is off or unconfigured.
     */
    images(
      query: string,
      maxResults: number,
    ): Effect.Effect<ReadonlyArray<ImageHit>, ToolUnavailable | SearchFailed>;
    /** Cheap check used by ChatService validation + composer availability. */
    availability(): Effect.Effect<{ configured: boolean; enabled: boolean }>;
  }
>()("chat/tools/WebSearchExecutor") {
  static readonly layer = Layer.effect(
    WebSearchExecutor,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const searchProviders = yield* SearchProviders;

      const makeHandler = Effect.fn("WebSearchExecutor.handler")(function* (
        indexer: SourceIndexer,
        authority: UrlAuthority,
        policy?: WebExecutionPolicy,
      ) {
        const tool = yield* repo.getWebSearch();
        if (!tool || tool.providers.length === 0) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "disabled" });
        }
        const { config, providers } = tool;
        const cached = yield* makeGenerationCache<SearchOutcome>({
          capacity: 128,
          retain: (outcome) => outcome.error === null,
        });
        const search = (query: string, params: WebSearchParams): Effect.Effect<SearchOutcome> => {
          const request = Effect.gen(function* () {
            // Only the producer takes a permit and admits an actual request. The
            // chain's fallbacks run inside that one permit and count as one search.
            if (policy && !policy.admit("search", 1))
              return {
                query,
                hits: [],
                error: "Research web budget or exploration deadline reached.",
              };
            return yield* searchProviders
              .search(providers, {
                query,
                maxResults: config.maxResults,
                ...(params.timeRange !== undefined ? { timeRange: params.timeRange } : {}),
                ...(params.language !== undefined ? { language: params.language } : {}),
              })
              .pipe(
                Effect.match({
                  onSuccess: (hits): SearchOutcome => {
                    policy?.observeSearch?.(true);
                    return { query, hits, error: null };
                  },
                  onFailure: (error): SearchOutcome => {
                    policy?.observeSearch?.(false);
                    return { query, hits: [], error: error.message };
                  },
                }),
              );
          });
          return cached(cacheKey(query, params), policy ? policy.run(request) : request);
        };

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

          const outcomes = yield* Effect.forEach(queries, (query) => search(query, params), {
            concurrency: 3,
          });

          const hits = mergeRoundRobin(outcomes);
          const failures: WebToolFailure[] = outcomes.flatMap((outcome) =>
            outcome.error ? [{ target: outcome.query, error: outcome.error }] : [],
          );
          const sources: WebSource[] = hits.map((hit) => {
            authority.allow(hit.url);
            return {
              kind: "web" as const,
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

      const images = Effect.fn("WebSearchExecutor.images")(function* (
        query: string,
        maxResults: number,
      ) {
        const tool = yield* repo.getWebSearch();
        if (!tool || tool.providers.length === 0) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "disabled" });
        }
        return yield* searchProviders.searchImages(tool.providers, { query, maxResults });
      });

      const availability = Effect.fn("WebSearchExecutor.availability")(function* () {
        const tool = yield* repo.getWebSearch();
        return {
          configured: (tool?.providers.length ?? 0) > 0,
          enabled: tool?.enabled ?? false,
        };
      });

      const researchSearchLimit = Effect.fn("WebSearchExecutor.researchSearchLimit")(function* () {
        const tool = yield* repo.getWebSearch();
        return tool?.config.researchMaxSearchQueries ?? RESEARCH_SEARCH_BUDGET.default;
      });

      return WebSearchExecutor.of({
        handler: makeHandler,
        images,
        availability,
        researchSearchLimit,
      });
    }),
  );
}
