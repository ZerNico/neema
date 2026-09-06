import type { WebExecutionPolicy } from "./execution-policy.ts";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, type Scope } from "effect";
import { Tool } from "effect/unstable/ai";
import {
  RESEARCH_SEARCH_BUDGET,
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

const cacheKey = (query: string, params: WebSearchParams) =>
  JSON.stringify([query, params.timeRange ?? null, params.language ?? null]);

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

interface PendingSearch {
  readonly state: "pending";
  readonly result: Deferred.Deferred<SearchOutcome>;
  producer?: Fiber.Fiber<SearchOutcome>;
  waiters: number;
}

type CachedSearch =
  | PendingSearch
  | { readonly state: "success"; readonly hits: ReadonlyArray<SearchHit> };

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
      policy?: WebExecutionPolicy,
    ): Effect.Effect<WebSearchHandler, ToolUnavailable, Scope.Scope>;
    /** Read once at research start; an active run keeps its captured allowance. */
    researchSearchLimit(): Effect.Effect<number>;
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
        policy?: WebExecutionPolicy,
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
        // Capture the generation scope, not the service/runtime or a worker's
        // scope: one cancelled waiter must not cancel another worker's search.
        const scope = yield* Effect.scope;
        const cache = new Map<string, CachedSearch>();

        const search = (query: string, params: WebSearchParams): Effect.Effect<SearchOutcome> =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const key = cacheKey(query, params);
              const cached = cache.get(key);
              if (cached?.state === "success") return { query, hits: cached.hits, error: null };

              const flight: PendingSearch = cached ?? {
                state: "pending",
                result: Deferred.makeUnsafe<SearchOutcome>(),
                waiters: 0,
              };
              // Claim and attach synchronously, before forking or awaiting.
              flight.waiters++;
              if (!cached) {
                cache.set(key, flight);
                const request = Effect.gen(function* () {
                  // Admission happens inside the shared permit, immediately
                  // before each actual request, never for a cached/shared wait.
                  if (policy && !policy.admit("search", 1))
                    return {
                      query,
                      hits: [],
                      error: "Research web budget or exploration deadline reached.",
                    };
                  return yield* backend
                    .search(connection, {
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
                flight.producer = yield* Effect.forkIn(
                  policy ? policy.run(request) : request,
                  scope,
                );
                // An observer also runs if scope closure interrupts the fiber
                // before its first instruction. Complete with the computed Exit,
                // never with backend work that Deferred would re-run per waiter.
                flight.producer.addObserver((exit) => {
                  if (cache.get(key) === flight) {
                    if (Exit.isSuccess(exit) && exit.value.error === null)
                      cache.set(key, { state: "success", hits: exit.value.hits });
                    else cache.delete(key);
                  }
                  Deferred.doneUnsafe(flight.result, exit);
                });
              }

              return yield* restore(Deferred.await(flight.result)).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    flight.waiters--;
                    if (flight.waiters === 0 && cache.get(key) === flight) {
                      // Evict before interruption so a retry cannot join dying work.
                      cache.delete(key);
                      if (flight.producer) yield* Fiber.interrupt(flight.producer);
                    }
                  }),
                ),
              );
            }),
          );

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

      const researchSearchLimit = Effect.fn("WebSearchExecutor.researchSearchLimit")(function* () {
        const tool = yield* repo.getWebSearch();
        return tool?.config.researchMaxSearchQueries ?? RESEARCH_SEARCH_BUDGET.default;
      });

      return WebSearchExecutor.of({ handler: makeHandler, availability, researchSearchLimit });
    }),
  );
}
