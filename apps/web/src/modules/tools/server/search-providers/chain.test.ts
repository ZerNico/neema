import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SearchProviders } from "./chain.ts";
import type { SearchProviderSnapshot } from "./types.ts";

/**
 * The real chain and adapters; only `fetch` is fake. Every provider is a
 * hosted kind told apart by its key, so `reply` decides per provider.
 */
type Reply = Response | "hang";
const chain = (reply: (key: string, body: unknown) => Reply) => {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const key = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    calls.push(key);
    const answer = reply(key, await request.json());
    if (answer !== "hang") return answer;
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason)),
    );
  }) as typeof globalThis.fetch;
  const layer = SearchProviders.layerWithoutHttp.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { calls, layer };
};

const provider = (
  key: string,
  kind: "tavily" | "jina" = "tavily",
  version = 0,
): SearchProviderSnapshot => ({
  id: key,
  label: key.toUpperCase(),
  version,
  settings: { kind },
  secret: Redacted.make(key),
});

const tavily = (...urls: string[]) =>
  Response.json({ results: urls.map((url) => ({ url, title: url, content: "" })) });
const jina = (...urls: string[]) =>
  Response.json({ data: urls.map((url) => ({ url, title: url, description: "" })) });
const status = (code: number, headers: Record<string, string> = {}) =>
  Response.json({ detail: "no" }, { status: code, headers });

const request = { query: "q", maxResults: 5 };

describe("search provider chain", () => {
  it.effect("falls over on failure and stops at the first answer, even an empty one", () => {
    const { calls, layer } = chain((key) =>
      key === "a" ? status(429) : key === "b" ? tavily() : tavily("https://c.example"),
    );
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const hits = yield* providers.search([provider("a"), provider("b"), provider("c")], request);
      expect(hits).toEqual([]);
      expect(calls).toEqual(["a", "b"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tries a cooling provider last until its cooldown ends", () => {
    let aDown = true;
    const { calls, layer } = chain((key) =>
      key === "a" && aDown
        ? status(429, { "retry-after": "60" })
        : tavily(`https://${key}.example`),
    );
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const list = [provider("a"), provider("b")];
      yield* providers.search(list, request);
      aDown = false;
      calls.length = 0;
      // Within the minute, b answers first and a is never reached.
      expect(yield* providers.search(list, request)).toEqual([
        { url: "https://b.example", title: "https://b.example", snippet: "" },
      ]);
      expect(calls).toEqual(["b"]);
      yield* TestClock.adjust(Duration.seconds(61));
      calls.length = 0;
      yield* providers.search(list, request);
      expect(calls).toEqual(["a"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still tries every provider when all are cooling, and lists each failure", () => {
    const { calls, layer } = chain((key) => (key === "a" ? status(401) : status(503)));
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const list = [provider("a"), provider("b")];
      yield* providers.search(list, request).pipe(Effect.flip);
      calls.length = 0;
      const error = yield* providers.search(list, request).pipe(Effect.flip);
      // b's 30s outage ends before a's hour for a rejected key.
      expect(calls).toEqual(["b", "a"]);
      expect(error.message).toBe("B: HTTP 503: no; A: key rejected (HTTP 401): no");
    }).pipe(Effect.provide(layer));
  });

  it.effect("forgets a provider's failures once it is edited", () => {
    const { calls, layer } = chain((key) => (key === "a" ? status(401) : tavily()));
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      yield* providers.search([provider("a"), provider("b")], request);
      calls.length = 0;
      yield* providers.search([provider("a", "tavily", 1), provider("b")], request);
      expect(calls).toEqual(["a", "b"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not bench a provider for refusing one query", () => {
    const { calls, layer } = chain((key) => (key === "a" ? status(400) : tavily()));
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const list = [provider("a"), provider("b")];
      yield* providers.search(list, request);
      calls.length = 0;
      yield* providers.search(list, request);
      expect(calls).toEqual(["a", "b"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tries date-capable providers first, then the rest without the filter", () => {
    const seen: Array<{ key: string; body: unknown }> = [];
    const { layer } = chain((key, body) => {
      seen.push({ key, body });
      return key === "t" ? status(503) : jina("https://j.example");
    });
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const hits = yield* providers.search([provider("j", "jina"), provider("t")], {
        ...request,
        timeRange: "day",
      });
      expect(hits.map((hit) => hit.url)).toEqual(["https://j.example"]);
      expect(seen.map((entry) => entry.key)).toEqual(["t", "j"]);
      expect(seen[0]!.body).toMatchObject({ time_range: "day" });
      expect(seen[1]!.body).toEqual({ q: "q" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops starting attempts once the query's deadline has passed", () => {
    const { calls, layer } = chain(() => "hang");
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const fiber = yield* providers
        .search([provider("a"), provider("b"), provider("c")], request)
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* TestClock.adjust(Duration.seconds(10));
      const error = yield* Fiber.join(fiber);
      expect(calls).toEqual(["a", "b"]);
      expect(error.message).toBe(
        "A: no answer within 10s; B: no answer within 10s; search took too long",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports what it last saw of each provider", () => {
    const { layer } = chain((key) =>
      key === "a" ? status(429, { "retry-after": "120" }) : tavily(),
    );
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      yield* providers.search([provider("a"), provider("b")], request);
      const byId = new Map((yield* providers.status()).map((entry) => [entry.providerId, entry]));
      expect(byId.get("a")).toMatchObject({
        version: 0,
        lastSuccessAt: null,
        lastError: { reason: "rate_limited" },
        coolingDownUntil: 120_000,
      });
      expect(byId.get("b")).toMatchObject({
        lastSuccessAt: 0,
        lastError: null,
        coolingDownUntil: null,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("tests one provider without touching its health", () => {
    const { layer } = chain(() => status(401));
    return Effect.gen(function* () {
      const providers = yield* SearchProviders;
      const error = yield* providers.test(provider("a")).pipe(Effect.flip);
      expect(error.reason).toBe("auth");
      expect(yield* providers.status()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "searches images only where a provider can, with health kept apart from web search",
    () => {
      const calls: string[] = [];
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new URL(new Request(input, init).url).host);
        return Response.json({ detail: "down" }, { status: 503 });
      }) as typeof globalThis.fetch;
      const layer = SearchProviders.layerWithoutHttp.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      );
      const searxng: SearchProviderSnapshot = {
        id: "s",
        label: "SearXNG",
        version: 0,
        settings: { kind: "searxng", baseUrl: "http://searx.test" },
        secret: null,
      };
      return Effect.gen(function* () {
        const providers = yield* SearchProviders;
        const error = yield* providers
          .searchImages([provider("a"), searxng], { query: "q", maxResults: 4 })
          .pipe(Effect.flip);
        expect(error.message).toContain("SearXNG");
        // Tavily has no image search, so only SearXNG was asked (config, then search).
        expect(calls.every((host) => host === "searx.test")).toBe(true);
        // The image failure cools nothing a web search would see.
        expect(yield* providers.status()).toEqual([]);
        const none = yield* providers
          .searchImages([provider("a")], { query: "q", maxResults: 4 })
          .pipe(Effect.flip);
        expect(none.message).toBe("no provider can search images");
      }).pipe(Effect.provide(layer));
    },
  );
});
