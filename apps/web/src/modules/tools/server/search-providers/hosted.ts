import { Clock, Effect, Schema } from "effect";
import { HttpClientRequest, type HttpClient } from "effect/unstable/http";
import {
  collectHits,
  fetchJson,
  invalidResponse,
  requireSecret,
  searchFailure,
  statusFailure,
  type FailedResponse,
} from "./http.ts";
import type { SearchAdapter, SearchRequest } from "./types.ts";

/**
 * Adapters for hosted search APIs. Each maps the shared request onto the
 * provider's parameters and its error statuses onto failure reasons; the
 * chain decides what a reason means for ordering.
 */

const Text = Schema.optionalKey(Schema.NullOr(Schema.String));
const decode = <S extends Schema.Top>(schema: S) => {
  const run = Schema.decodeUnknownEffect(schema);
  return (json: unknown) => run(json).pipe(Effect.mapError(invalidResponse));
};
const language = (request: SearchRequest) => request.language?.split(/[-_]/)[0]?.toLowerCase();
const DAY_MS = 86_400_000;
const RANGE_DAYS = { day: 1, month: 31, year: 366 } as const;

const TavilyResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Text,
      content: Text,
      score: Schema.optionalKey(Schema.Number),
    }),
  ),
});
const decodeTavily = decode(TavilyResponse);

export const makeTavilyAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  supports: { timeRange: true, language: false, maxResults: 20 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const json = yield* fetchJson(
        http,
        HttpClientRequest.post("https://api.tavily.com/search").pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.bodyJsonUnsafe({
            query: request.query,
            max_results: request.maxResults,
            search_depth: "basic",
            ...(request.timeRange ? { time_range: request.timeRange } : {}),
          }),
        ),
        // 432 is the plan's credits, 433 the pay-as-you-go cap.
        (response) =>
          response.status === 432 || response.status === 433
            ? searchFailure("quota", `credits used up (HTTP ${response.status})`)
            : undefined,
      );
      const body = yield* decodeTavily(json);
      return collectHits(
        body.results.map((r) => ({ url: r.url, title: r.title, snippet: r.content })),
        request.maxResults,
        (index) => {
          const score = body.results[index]?.score;
          return score !== undefined ? { score } : {};
        },
      );
    }),
});

const BraveResponse = Schema.Struct({
  web: Schema.optionalKey(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ url: Schema.String, title: Text, description: Text })),
    }),
  ),
});
const decodeBrave = decode(BraveResponse);
const BRAVE_FRESHNESS = { day: "pd", month: "pm", year: "py" } as const;
// Brave marks query terms with <strong> in descriptions.
const stripTags = (value: string | null | undefined) => value?.replace(/<[^>]+>/g, "");

/**
 * Brave sends per-window limits as comma lists, per-second first, then
 * per-month; `Reset` is seconds from now. A used-up monthly window is quota,
 * anything else a rate limit.
 */
const braveLimit = (response: FailedResponse) => {
  const remaining = (response.headers["x-ratelimit-remaining"] ?? "").split(",").map(Number);
  const reset = (response.headers["x-ratelimit-reset"] ?? "").split(",").map(Number);
  const monthly = remaining.length > 1 && remaining.at(-1) === 0;
  const seconds = monthly ? reset.at(-1) : reset[0];
  const retryAfter =
    seconds !== undefined && Number.isFinite(seconds) ? seconds * 1000 : response.retryAfterMs;
  return monthly
    ? searchFailure("quota", "monthly credits used up (HTTP 429)", retryAfter)
    : searchFailure("rate_limited", "rate limited (HTTP 429)", retryAfter);
};

export const makeBraveAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  supports: { timeRange: true, language: true, maxResults: 20 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const lang = language(request);
      const json = yield* fetchJson(
        http,
        HttpClientRequest.get("https://api.search.brave.com/res/v1/web/search").pipe(
          HttpClientRequest.setHeader("X-Subscription-Token", key),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setUrlParams({
            q: request.query,
            count: String(request.maxResults),
            ...(request.timeRange ? { freshness: BRAVE_FRESHNESS[request.timeRange] } : {}),
            ...(lang ? { search_lang: lang } : {}),
          }),
        ),
        (response) => {
          // An invalid key is a 422 with this code, not a 401.
          if (response.status === 422 && JSON.stringify(response.body).includes("TOKEN_INVALID"))
            return searchFailure("auth", "key rejected (HTTP 422)");
          if (response.status === 429) return braveLimit(response);
          return undefined;
        },
      );
      const body = yield* decodeBrave(json);
      return collectHits(
        (body.web?.results ?? []).map((r) => ({
          url: r.url,
          title: stripTags(r.title),
          snippet: stripTags(r.description),
        })),
        request.maxResults,
      );
    }),
});

const ExaResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Text,
      highlights: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    }),
  ),
});
const decodeExa = decode(ExaResponse);

export const makeExaAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  // Exa bills extra beyond ten results.
  supports: { timeRange: true, language: false, maxResults: 10 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const now = yield* Clock.currentTimeMillis;
      const json = yield* fetchJson(
        http,
        HttpClientRequest.post("https://api.exa.ai/search").pipe(
          HttpClientRequest.setHeader("x-api-key", key),
          HttpClientRequest.bodyJsonUnsafe({
            query: request.query,
            numResults: request.maxResults,
            type: "auto",
            // Exa has no snippet unless asked for highlights.
            contents: { highlights: true },
            ...(request.timeRange
              ? {
                  startPublishedDate: new Date(
                    now - RANGE_DAYS[request.timeRange] * DAY_MS,
                  ).toISOString(),
                }
              : {}),
          }),
        ),
      );
      const body = yield* decodeExa(json);
      return collectHits(
        body.results.map((r) => ({
          url: r.url,
          title: r.title,
          snippet: (r.highlights ?? []).join(" … "),
        })),
        request.maxResults,
      );
    }),
});

const SerperResponse = Schema.Struct({
  organic: Schema.optionalKey(
    Schema.Array(Schema.Struct({ link: Schema.String, title: Text, snippet: Text })),
  ),
});
const decodeSerper = decode(SerperResponse);
const SERPER_RANGE = { day: "qdr:d", month: "qdr:m", year: "qdr:y" } as const;

export const makeSerperAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  // Its default page of ten costs one credit; more costs two.
  supports: { timeRange: true, language: true, maxResults: 10 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const lang = language(request);
      const json = yield* fetchJson(
        http,
        HttpClientRequest.post("https://google.serper.dev/search").pipe(
          HttpClientRequest.setHeader("X-API-KEY", key),
          HttpClientRequest.bodyJsonUnsafe({
            q: request.query,
            ...(request.timeRange ? { tbs: SERPER_RANGE[request.timeRange] } : {}),
            ...(lang ? { hl: lang } : {}),
          }),
        ),
        // Running out of credits is a 400 rather than a quota status.
        (response) =>
          response.status === 400 && /credit/i.test(response.detail)
            ? searchFailure("quota", `credits used up: ${response.detail}`)
            : undefined,
      );
      const body = yield* decodeSerper(json);
      return collectHits(
        (body.organic ?? []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet })),
        request.maxResults,
      );
    }),
});

const JinaResponse = Schema.Struct({
  data: Schema.NullOr(
    Schema.Array(Schema.Struct({ url: Schema.String, title: Text, description: Text })),
  ),
});
const decodeJina = decode(JinaResponse);

export const makeJinaAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  supports: { timeRange: false, language: true, maxResults: 10 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const lang = language(request);
      const json = yield* fetchJson(
        http,
        HttpClientRequest.post("https://s.jina.ai/").pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.acceptJson,
          // Without this Jina fetches every result page, which is slow and costly.
          HttpClientRequest.setHeader("X-Respond-With", "no-content"),
          HttpClientRequest.bodyJsonUnsafe({ q: request.query, ...(lang ? { hl: lang } : {}) }),
        ),
      );
      const body = yield* decodeJina(json);
      return collectHits(
        (body.data ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.description })),
        request.maxResults,
      );
    }),
});

const LangSearchResponse = Schema.Struct({
  code: Schema.optionalKey(Schema.Number),
  msg: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        webPages: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              value: Schema.Array(Schema.Struct({ url: Schema.String, name: Text, snippet: Text })),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeLangSearch = decode(LangSearchResponse);
const LANGSEARCH_FRESHNESS = { day: "oneDay", month: "oneMonth", year: "oneYear" } as const;

export const makeLangSearchAdapter = (http: HttpClient.HttpClient): SearchAdapter => ({
  supports: { timeRange: true, language: false, maxResults: 20 },
  search: (provider, request) =>
    Effect.gen(function* () {
      const key = yield* requireSecret(provider);
      const json = yield* fetchJson(
        http,
        HttpClientRequest.post("https://api.langsearch.com/v1/web-search").pipe(
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.bodyJsonUnsafe({
            query: request.query,
            count: request.maxResults,
            summary: false,
            ...(request.timeRange ? { freshness: LANGSEARCH_FRESHNESS[request.timeRange] } : {}),
          }),
        ),
      );
      const body = yield* decodeLangSearch(json);
      // Some failures arrive as HTTP 200 with the status in the body.
      if (body.code !== undefined && body.code !== 200)
        return yield* statusFailure(body.code, body.msg ?? "");
      return collectHits(
        (body.data?.webPages?.value ?? []).map((r) => ({
          url: r.url,
          title: r.name,
          snippet: r.snippet,
        })),
        request.maxResults,
      );
    }),
});
