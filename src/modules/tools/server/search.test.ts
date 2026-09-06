import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SearchBackend } from "./search.ts";

// Mock fetch so the SearXNG parsing/dedup/limits are tested without a server.
const mockFetch = (handler: (url: URL) => Response) =>
  Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Promise.resolve(handler(url));
  }) as typeof fetch);

const backendWith = (handler: (url: URL) => Response) =>
  SearchBackend.searxngLayer.pipe(Layer.provide(mockFetch(handler)));

const searxngJson = (results: unknown[]) =>
  new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connection = { baseUrl: "http://localhost:8081", secret: null };

describe("SearxngBackend", () => {
  it.effect("parses results and maps fields", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const hits = yield* backend.search(connection, { query: "effect", maxResults: 5 });
      expect(hits).toEqual([
        {
          url: "https://effect.website",
          title: "Effect",
          snippet: "TS library",
          engine: "ddg",
          score: 2.5,
        },
      ]);
    }).pipe(
      Effect.provide(
        backendWith((url) => {
          expect(url.pathname).toBe("/search");
          expect(url.searchParams.get("q")).toBe("effect");
          expect(url.searchParams.get("format")).toBe("json");
          return searxngJson([
            {
              url: "https://effect.website",
              title: "Effect",
              content: "TS library",
              engine: "ddg",
              score: 2.5,
            },
          ]);
        }),
      ),
    ),
  );

  it.effect("dedupes by normalized url and caps at maxResults", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const hits = yield* backend.search(connection, { query: "x", maxResults: 2 });
      expect(hits.map((h) => h.url)).toEqual(["https://a.com/", "https://b.com"]);
    }).pipe(
      Effect.provide(
        backendWith(() =>
          searxngJson([
            { url: "https://a.com/", title: "a" },
            { url: "https://a.com", title: "a dup" },
            { url: "https://b.com", title: "b" },
            { url: "https://c.com", title: "c (over cap)" },
          ]),
        ),
      ),
    ),
  );

  it.effect("tolerates missing optional fields", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const hits = yield* backend.search(connection, { query: "x", maxResults: 5 });
      expect(hits[0]).toEqual({ url: "https://a.com", title: "https://a.com", snippet: "" });
    }).pipe(Effect.provide(backendWith(() => searxngJson([{ url: "https://a.com" }])))),
  );

  it.effect("maps 403 to a settings hint", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const error = yield* backend
        .search(connection, { query: "x", maxResults: 5 })
        .pipe(Effect.flip);
      expect(error._tag).toBe("SearchBackendError");
      expect(error.message).toContain("json format");
    }).pipe(Effect.provide(backendWith(() => new Response("forbidden", { status: 403 })))),
  );

  it.effect("passes time_range and language params", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      yield* backend.search(connection, {
        query: "x",
        maxResults: 5,
        timeRange: "month",
        language: "de",
      });
    }).pipe(
      Effect.provide(
        backendWith((url) => {
          expect(url.searchParams.get("time_range")).toBe("month");
          expect(url.searchParams.get("language")).toBe("de");
          return searxngJson([]);
        }),
      ),
    ),
  );

  it.effect("fails when every engine is unresponsive instead of returning nothing", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const error = yield* backend
        .search(connection, { query: "x", maxResults: 5 })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "search engines unavailable (too many requests, Suspended: CAPTCHA)",
      );
    }).pipe(
      Effect.provide(
        backendWith(
          () =>
            new Response(
              JSON.stringify({
                results: [],
                unresponsive_engines: [
                  ["brave", "too many requests"],
                  ["google", "too many requests"],
                  ["startpage", "Suspended: CAPTCHA"],
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        ),
      ),
    ),
  );

  it.effect("fails on malformed json bodies", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const error = yield* backend
        .search(connection, { query: "x", maxResults: 5 })
        .pipe(Effect.flip);
      expect(error._tag).toBe("SearchBackendError");
    }).pipe(
      Effect.provide(
        backendWith(
          () =>
            new Response(JSON.stringify({ nope: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      ),
    ),
  );
});
