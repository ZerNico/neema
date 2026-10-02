import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result } from "effect";
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
import type { SearchAdapter, SearchProviderSnapshot, SearchRequest } from "./types.ts";

type Hosted = Exclude<SearchProviderKind, "searxng">;
const makers: Record<Hosted, (http: HttpClient.HttpClient) => SearchAdapter> = {
  tavily: makeTavilyAdapter,
  brave: makeBraveAdapter,
  exa: makeExaAdapter,
  serper: makeSerperAdapter,
  jina: makeJinaAdapter,
  langsearch: makeLangSearchAdapter,
};

const provider = (kind: Hosted, secret: string | null = "key-1"): SearchProviderSnapshot => ({
  id: kind,
  label: kind,
  version: 0,
  settings: { kind },
  secret: secret === null ? null : Redacted.make(secret),
});

interface Seen {
  request: Request;
  body: unknown;
}

/** Runs one search through the real adapter with `fetch` answered by `reply`. */
const run = (
  kind: Hosted,
  request: SearchRequest,
  reply: (seen: Seen) => Response,
  secret?: string | null,
) => {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Request(input, init);
    const text = await sent.clone().text();
    const entry = { request: sent, body: text ? JSON.parse(text) : undefined };
    seen.push(entry);
    return reply(entry);
  }) as typeof globalThis.fetch;
  return Effect.gen(function* () {
    const adapter = makers[kind](yield* HttpClient.HttpClient);
    const result = yield* Effect.result(adapter.search(provider(kind, secret), request));
    return { result, seen };
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

const failureOf = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};
const successOf = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${String(result.failure)}`);
  return result.success;
};

describe("hosted search adapters", () => {
  it.effect("Tavily posts the query with a bearer key and maps its results", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "tavily",
        { query: "effect", maxResults: 3, timeRange: "month", language: "de" },
        () =>
          json({
            results: [
              { url: "https://a.example/", title: "A", content: "first", score: 0.9 },
              { url: "https://a.example", title: "A again", content: "dup" },
              { url: "https://b.example", title: null, content: null },
            ],
          }),
      );
      expect(successOf(result)).toEqual([
        { url: "https://a.example/", title: "A", snippet: "first", score: 0.9 },
        { url: "https://b.example", title: "https://b.example", snippet: "" },
      ]);
      const [call] = seen;
      expect(call!.request.url).toBe("https://api.tavily.com/search");
      expect(call!.request.headers.get("authorization")).toBe("Bearer key-1");
      // Tavily's language only boosts ranking, so it is not sent.
      expect(call!.body).toEqual({
        query: "effect",
        max_results: 3,
        search_depth: "basic",
        time_range: "month",
      });
    }),
  );

  it.effect.each([
    [432, "quota"],
    [433, "quota"],
    [401, "auth"],
    [503, "unavailable"],
    [400, "rejected"],
  ] as const)("Tavily HTTP %i is %s", ([status, reason]) =>
    Effect.gen(function* () {
      const { result } = yield* run("tavily", { query: "x", maxResults: 5 }, () =>
        json({ detail: { error: "nope" } }, status),
      );
      expect(failureOf(result)).toMatchObject({ reason });
    }),
  );

  it.effect("a rate limit carries Retry-After", () =>
    Effect.gen(function* () {
      const { result } = yield* run("tavily", { query: "x", maxResults: 5 }, () =>
        json({}, 429, { "retry-after": "30" }),
      );
      expect(failureOf(result)).toMatchObject({ reason: "rate_limited", retryAfterMs: 30_000 });
    }),
  );

  it.effect("fails as auth without a request when no key is stored", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "serper",
        { query: "x", maxResults: 5 },
        () => json({}),
        null,
      );
      expect(failureOf(result)).toMatchObject({ reason: "auth" });
      expect(seen).toHaveLength(0);
    }),
  );

  it.effect("Brave sends its token, freshness and base language, and strips highlight tags", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "brave",
        { query: "q", maxResults: 4, timeRange: "month", language: "de-DE" },
        () =>
          json({
            web: {
              results: [
                { url: "https://a.example", title: "A", description: "<strong>q</strong> here" },
              ],
            },
          }),
      );
      expect(successOf(result)).toEqual([
        { url: "https://a.example", title: "A", snippet: "q here" },
      ]);
      const url = new URL(seen[0]!.request.url);
      expect(seen[0]!.request.headers.get("x-subscription-token")).toBe("key-1");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        q: "q",
        count: "4",
        freshness: "pm",
        search_lang: "de",
      });
    }),
  );

  it.effect("Brave with no web section is an empty answer", () =>
    Effect.gen(function* () {
      const { result } = yield* run("brave", { query: "q", maxResults: 4 }, () => json({}));
      expect(successOf(result)).toEqual([]);
    }),
  );

  it.effect("Brave reports an invalid token as a 422", () =>
    Effect.gen(function* () {
      const { result } = yield* run("brave", { query: "q", maxResults: 4 }, () =>
        json({ error: { code: "SUBSCRIPTION_TOKEN_INVALID" } }, 422),
      );
      expect(failureOf(result)).toMatchObject({ reason: "auth" });
    }),
  );

  it.effect("Brave tells a spent month from a per-second limit by its headers", () =>
    Effect.gen(function* () {
      const monthly = yield* run("brave", { query: "q", maxResults: 4 }, () =>
        json({}, 429, { "x-ratelimit-remaining": "0, 0", "x-ratelimit-reset": "1, 86400" }),
      );
      expect(failureOf(monthly.result)).toMatchObject({
        reason: "quota",
        retryAfterMs: 86_400_000,
      });
      const burst = yield* run("brave", { query: "q", maxResults: 4 }, () =>
        json({}, 429, { "x-ratelimit-remaining": "0, 900", "x-ratelimit-reset": "1, 86400" }),
      );
      expect(failureOf(burst.result)).toMatchObject({ reason: "rate_limited", retryAfterMs: 1000 });
    }),
  );

  it.effect("Exa asks for highlights, dates a ranged query and joins highlights", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "exa",
        { query: "q", maxResults: 5, timeRange: "day" },
        () =>
          json({
            results: [{ url: "https://a.example", title: "A", highlights: ["one", "two"] }],
          }),
      );
      expect(successOf(result)).toEqual([
        { url: "https://a.example", title: "A", snippet: "one … two" },
      ]);
      expect(seen[0]!.request.headers.get("x-api-key")).toBe("key-1");
      // TestClock starts at the epoch, so a day back is before it.
      expect(seen[0]!.body).toEqual({
        query: "q",
        numResults: 5,
        type: "auto",
        contents: { highlights: true },
        startPublishedDate: new Date(-86_400_000).toISOString(),
      });
    }),
  );

  it.effect("Exa HTTP 402 is out of credits", () =>
    Effect.gen(function* () {
      const { result } = yield* run("exa", { query: "q", maxResults: 5 }, () => json({}, 402));
      expect(failureOf(result)).toMatchObject({ reason: "quota" });
    }),
  );

  it.effect("Serper maps organic links and its Google time codes", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "serper",
        { query: "q", maxResults: 1, timeRange: "year", language: "en" },
        () =>
          json({
            organic: [
              { link: "https://a.example", title: "A", snippet: "s" },
              { link: "https://b.example", title: "B", snippet: "t" },
            ],
          }),
      );
      expect(successOf(result)).toEqual([{ url: "https://a.example", title: "A", snippet: "s" }]);
      expect(seen[0]!.request.headers.get("x-api-key")).toBe("key-1");
      expect(seen[0]!.body).toEqual({ q: "q", tbs: "qdr:y", hl: "en" });
    }),
  );

  it.effect("Serper's out-of-credits 400 is quota, any other 400 is this query", () =>
    Effect.gen(function* () {
      const credits = yield* run("serper", { query: "q", maxResults: 5 }, () =>
        json({ message: "Not enough credits" }, 400),
      );
      expect(failureOf(credits.result)).toMatchObject({ reason: "quota" });
      const other = yield* run("serper", { query: "q", maxResults: 5 }, () =>
        json({ message: "Query too long" }, 400),
      );
      expect(failureOf(other.result)).toMatchObject({ reason: "rejected" });
    }),
  );

  it.effect("Jina asks for JSON without crawling the result pages", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run("jina", { query: "q", maxResults: 5 }, () =>
        json({ data: [{ url: "https://a.example", title: "A", description: "d" }] }),
      );
      expect(successOf(result)).toEqual([{ url: "https://a.example", title: "A", snippet: "d" }]);
      const headers = seen[0]!.request.headers;
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("x-respond-with")).toBe("no-content");
      expect(headers.get("authorization")).toBe("Bearer key-1");
      const empty = yield* run("jina", { query: "q", maxResults: 5 }, () => json({ data: null }));
      expect(successOf(empty.result)).toEqual([]);
    }),
  );

  it.effect("LangSearch reads its nested pages and a failure reported inside a 200", () =>
    Effect.gen(function* () {
      const { result, seen } = yield* run(
        "langsearch",
        { query: "q", maxResults: 5, timeRange: "year" },
        () =>
          json({
            code: 200,
            data: { webPages: { value: [{ url: "https://a.example", name: "A", snippet: "s" }] } },
          }),
      );
      expect(successOf(result)).toEqual([{ url: "https://a.example", title: "A", snippet: "s" }]);
      expect(seen[0]!.body).toEqual({ query: "q", count: 5, summary: false, freshness: "oneYear" });
      const limited = yield* run("langsearch", { query: "q", maxResults: 5 }, () =>
        json({ code: 429, msg: "daily limit reached" }),
      );
      expect(failureOf(limited.result)).toMatchObject({ reason: "rate_limited" });
    }),
  );

  it.effect("an unexpected body shape is the provider being unavailable", () =>
    Effect.gen(function* () {
      const { result } = yield* run("tavily", { query: "q", maxResults: 5 }, () =>
        json({ nope: true }),
      );
      expect(failureOf(result)).toMatchObject({ reason: "unavailable" });
    }),
  );
});
