import { Clock, Context, Duration, Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import type { SearchProviderKind } from "../../schema.ts";
import {
  makeBraveAdapter,
  makeExaAdapter,
  makeJinaAdapter,
  makeLangSearchAdapter,
  makeSerperAdapter,
  makeTavilyAdapter,
} from "./hosted.ts";
import { searchFailure } from "./http.ts";
import { makeSearxngAdapter } from "./searxng.ts";
import type {
  SearchAdapter,
  SearchFailureReason,
  SearchHit,
  SearchProviderError,
  SearchProviderSnapshot,
  SearchRequest,
} from "./types.ts";

/** Every provider in the chain failed this query; the message lists each attempt. */
export class SearchFailed extends Schema.TaggedError<SearchFailed>()("SearchFailed", {
  message: Schema.String,
}) {}

export interface SearchProviderStatus {
  readonly providerId: string;
  /** The provider version this health belongs to; an edit starts afresh. */
  readonly version: number;
  readonly lastSuccessAt: number | null;
  readonly lastError: {
    readonly reason: SearchFailureReason;
    readonly message: string;
    readonly at: number;
  } | null;
  readonly coolingDownUntil: number | null;
}

// One attempt never outlives this, and a query starts no attempt past its deadline.
const ATTEMPT_TIMEOUT_MS = 10_000;
const QUERY_DEADLINE_MS = 20_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Health {
  version: number;
  consecutiveFailures: number;
  until: number;
  lastSuccessAt: number | null;
  lastError: SearchProviderStatus["lastError"];
}

/** How long a failure sends a provider to the back of the order. */
const cooldownMs = (error: SearchProviderError, consecutiveFailures: number): number => {
  const backoff = (base: number, cap: number) =>
    Math.min(cap, base * 2 ** Math.max(0, consecutiveFailures - 1));
  switch (error.reason) {
    case "rejected":
      return 0;
    case "auth":
      return HOUR;
    case "quota":
      return error.retryAfterMs ?? HOUR;
    case "rate_limited":
      // Some providers say "daily allowance used" with a bare 429, so repeats back off.
      return error.retryAfterMs ?? backoff(MINUTE, HOUR);
    case "unavailable":
      return backoff(30_000, 10 * MINUTE);
  }
};

/**
 * Orders providers for one query. Nothing is ever removed: a provider cooling
 * down only moves behind the healthy ones, so local state can reorder the
 * chain but never empty it. A dated query first tries providers that can
 * filter by date.
 */
export const orderProviders = (
  providers: ReadonlyArray<SearchProviderSnapshot>,
  request: SearchRequest,
  filtersByDate: (provider: SearchProviderSnapshot) => boolean,
  coolingUntil: (provider: SearchProviderSnapshot) => number,
  now: number,
): SearchProviderSnapshot[] =>
  providers
    .map((provider, position) => {
      const until = coolingUntil(provider);
      return {
        provider,
        position,
        dated: request.timeRange && !filtersByDate(provider) ? 1 : 0,
        cooling: until > now ? until : 0,
      };
    })
    // Sorting the mapped copy, never the caller's list.
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => a.dated - b.dated || a.cooling - b.cooling || a.position - b.position)
    .map((entry) => entry.provider);

const fitRequest = (
  supports: SearchAdapter["supports"],
  request: SearchRequest,
): SearchRequest => ({
  query: request.query,
  maxResults: Math.min(request.maxResults, supports.maxResults),
  ...(request.timeRange && supports.timeRange ? { timeRange: request.timeRange } : {}),
  ...(request.language && supports.language ? { language: request.language } : {}),
});

/**
 * Web search across the configured providers. A query walks the ordered
 * chain until one answers; an empty answer is an answer. Provider health is
 * process memory: one process serves the app, and a restart costs at most
 * one failed request per exhausted provider.
 */
export class SearchProviders extends Context.Service<
  SearchProviders,
  {
    search(
      providers: ReadonlyArray<SearchProviderSnapshot>,
      request: SearchRequest,
    ): Effect.Effect<ReadonlyArray<SearchHit>, SearchFailed>;
    /** One attempt against one provider, outside the chain and its health. */
    test(
      provider: SearchProviderSnapshot,
    ): Effect.Effect<{ resultCount: number }, SearchProviderError>;
    status(): Effect.Effect<ReadonlyArray<SearchProviderStatus>>;
  }
>()("chat/tools/SearchProviders") {
  static readonly layerWithoutHttp = Layer.effect(
    SearchProviders,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const adapters: Record<SearchProviderKind, SearchAdapter> = {
        searxng: yield* makeSearxngAdapter,
        tavily: makeTavilyAdapter(http),
        brave: makeBraveAdapter(http),
        exa: makeExaAdapter(http),
        serper: makeSerperAdapter(http),
        jina: makeJinaAdapter(http),
        langsearch: makeLangSearchAdapter(http),
      };
      const health = new Map<string, Health>();
      const current = (provider: SearchProviderSnapshot) => {
        const entry = health.get(provider.id);
        return entry?.version === provider.version ? entry : undefined;
      };
      const entryFor = (provider: SearchProviderSnapshot): Health => {
        const existing = current(provider);
        if (existing) return existing;
        const fresh: Health = {
          version: provider.version,
          consecutiveFailures: 0,
          until: 0,
          lastSuccessAt: null,
          lastError: null,
        };
        health.set(provider.id, fresh);
        return fresh;
      };

      const attempt = (
        provider: SearchProviderSnapshot,
        request: SearchRequest,
        timeoutMs: number,
      ) => {
        const adapter = adapters[provider.settings.kind];
        return adapter.search(provider, fitRequest(adapter.supports, request)).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () =>
              Effect.fail(searchFailure("unavailable", `no answer within ${timeoutMs / 1000}s`)),
          }),
        );
      };

      const search = Effect.fn("SearchProviders.search")(function* (
        providers: ReadonlyArray<SearchProviderSnapshot>,
        request: SearchRequest,
      ) {
        const started = yield* Clock.currentTimeMillis;
        const ordered = orderProviders(
          providers,
          request,
          (provider) => adapters[provider.settings.kind].supports.timeRange,
          (provider) => current(provider)?.until ?? 0,
          started,
        );
        const failures: string[] = [];
        for (const provider of ordered) {
          const now = yield* Clock.currentTimeMillis;
          const remaining = started + QUERY_DEADLINE_MS - now;
          if (remaining <= 0) {
            failures.push("search took too long");
            break;
          }
          const outcome = yield* Effect.result(
            attempt(provider, request, Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
          );
          const finished = yield* Clock.currentTimeMillis;
          const entry = entryFor(provider);
          if (Result.isSuccess(outcome)) {
            entry.consecutiveFailures = 0;
            entry.until = 0;
            entry.lastSuccessAt = finished;
            return outcome.success;
          }
          const error = outcome.failure;
          if (error.reason !== "rejected") entry.consecutiveFailures++;
          entry.until = finished + cooldownMs(error, entry.consecutiveFailures);
          entry.lastError = { reason: error.reason, message: error.message, at: finished };
          failures.push(`${provider.label}: ${error.message}`);
          yield* Effect.logWarning("web search provider failed; trying the next").pipe(
            Effect.annotateLogs({ provider: provider.label, reason: error.reason }),
          );
        }
        return yield* new SearchFailed({
          message: failures.length ? failures.join("; ") : "no search provider is enabled",
        });
      });

      const test = Effect.fn("SearchProviders.test")(function* (provider: SearchProviderSnapshot) {
        const hits = yield* attempt(
          provider,
          { query: "open source", maxResults: 5 },
          ATTEMPT_TIMEOUT_MS,
        );
        return { resultCount: hits.length };
      });

      const status = Effect.fn("SearchProviders.status")(function* () {
        const now = yield* Clock.currentTimeMillis;
        return [...health].map(([providerId, entry]): SearchProviderStatus => ({
          providerId,
          version: entry.version,
          lastSuccessAt: entry.lastSuccessAt,
          lastError: entry.lastError,
          coolingDownUntil: entry.until > now ? entry.until : null,
        }));
      });

      return SearchProviders.of({ search, test, status });
    }),
  );

  static readonly layer = SearchProviders.layerWithoutHttp.pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
