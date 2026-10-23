import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeSearxngAdapter } from "./searxng.ts";
import type { SearchAdapter, SearchProviderSnapshot } from "./types.ts";

// The adapter needs a scope for its config cache, so a layer holds one here.
class SearchBackend extends Context.Service<SearchBackend, SearchAdapter>()("test/Searxng") {
  static readonly searxngLayer = Layer.effect(SearchBackend, makeSearxngAdapter).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}

// Mock fetch so the SearXNG parsing/dedup/limits are tested without a server.
const mockFetch = (handler: (url: URL) => Response) =>
  Layer.succeed(FetchHttpClient.Fetch, ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Promise.resolve(handler(url));
  }) as typeof fetch);

const backendWith = (handler: (url: URL) => Response, config?: () => Response) =>
  SearchBackend.searxngLayer.pipe(
    Layer.provide(
      mockFetch((url) =>
        url.pathname === "/config"
          ? (config?.() ??
            Response.json({
              engines: ["brave", "google", "startpage"].map((name) => ({
                name,
                enabled: true,
                categories: ["general"],
                time_range_support: true,
              })),
            }))
          : handler(url),
      ),
    ),
  );

const searxngJson = (results: unknown[]) =>
  new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const at = (baseUrl: string, secret: string | null = null): SearchProviderSnapshot => ({
  id: "searxng",
  label: "SearXNG",
  version: 0,
  settings: { kind: "searxng", baseUrl },
  secret: secret === null ? null : Redacted.make(secret),
});
const connection = at("http://localhost:8081");

describe("SearxngBackend", () => {
  it.effect(
    "shares config across distinct queries, filters per request, expires and isolates credentials",
    () => {
      let configs = 0;
      return Effect.gen(function* () {
        const backend = yield* SearchBackend;
        yield* Effect.all(
          [
            backend.search(connection, { query: "one", maxResults: 2 }),
            backend.search(at("http://localhost:8081/"), {
              query: "two",
              maxResults: 2,
              timeRange: "year",
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(configs).toBe(1);
        yield* TestClock.adjust(Duration.millis(59_999));
        yield* backend.search(connection, { query: "three", maxResults: 2 });
        expect(configs).toBe(1);
        yield* TestClock.adjust(Duration.millis(2));
        yield* backend.search(connection, { query: "four", maxResults: 2 });
        expect(configs).toBe(2);
        yield* backend.search(at("http://localhost:8081", "another-identity"), {
          query: "five",
          maxResults: 2,
        });
        yield* backend.search(at("http://other.test"), { query: "six", maxResults: 2 });
        expect(configs).toBe(4);
      }).pipe(
        Effect.provide(
          backendWith(
            (url) => {
              expect(url.searchParams.get("engines")).toBe(
                url.searchParams.has("time_range") ? "dated" : "dated,plain",
              );
              return searxngJson([]);
            },
            () => {
              configs++;
              return Response.json({
                engines: [true, false].map((supported) => ({
                  name: supported ? "dated" : "plain",
                  enabled: true,
                  categories: ["general"],
                  time_range_support: supported,
                })),
              });
            },
          ),
        ),
      );
    },
  );

  it.effect(
    "caches unknown config only five seconds and bounds completed connections to sixteen",
    () => {
      let configs = 0;
      return Effect.gen(function* () {
        const backend = yield* SearchBackend;
        const query = { query: "empty", maxResults: 2 };
        yield* backend.search(connection, query);
        yield* backend.search(connection, query);
        expect(configs).toBe(1);
        yield* TestClock.adjust(Duration.seconds(5));
        yield* backend.search(connection, query);
        expect(configs).toBe(2);
        for (let n = 0; n < 16; n++)
          yield* backend.search(at(`http://connection-${n}.test`), query);
        yield* backend.search(connection, query);
        expect(configs).toBe(19);
      }).pipe(
        Effect.provide(
          backendWith(
            () => Response.json({ results: [], unresponsive_engines: [["dated", "down"]] }),
            () => {
              configs++;
              return new Response("unavailable", { status: 503 });
            },
          ),
        ),
      );
    },
  );

  it.effect("one cancelled waiter preserves shared config work and the last cancels it", () =>
    Effect.gen(function* () {
      let release!: (response: Response) => void;
      let calls = 0;
      let aborted = 0;
      const started = yield* Deferred.make<void>();
      const lastStarted = yield* Deferred.make<void>();
      const fetchLayer = Layer.succeed(FetchHttpClient.Fetch, ((
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = new URL(String(_input));
        if (url.pathname !== "/config") return Promise.resolve(searxngJson([]));
        calls++;
        Effect.runSync(Deferred.succeed(calls === 1 ? started : lastStarted, undefined));
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++;
          },
          { once: true },
        );
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }) as typeof fetch);
      yield* Effect.gen(function* () {
        const backend = yield* SearchBackend;
        const first = yield* backend
          .search(connection, { query: "one", maxResults: 2 })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const second = yield* backend
          .search(connection, { query: "two", maxResults: 2 })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        expect(aborted).toBe(0);
        release(Response.json({ engines: [] }));
        yield* Fiber.join(second);
        expect(calls).toBe(1);
        const last = yield* backend
          .search(at("http://other.test"), { query: "last", maxResults: 2 })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(lastStarted);
        yield* Fiber.interrupt(last);
        expect(aborted).toBeGreaterThanOrEqual(1);
      }).pipe(Effect.provide(SearchBackend.searxngLayer.pipe(Layer.provide(fetchLayer))));
    }).pipe(Effect.scoped),
  );

  it.effect("the config deadline includes a stalled JSON body", () => {
    let configs = 0;
    return Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const pending = yield* backend
        .search(connection, { query: "body stall", maxResults: 2 })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(3));
      expect(yield* Fiber.join(pending)).toEqual([]);
      yield* backend.search(connection, { query: "cached unknown", maxResults: 2 });
      expect(configs).toBe(1);
    }).pipe(
      Effect.provide(
        backendWith(
          () => searxngJson([]),
          () => {
            configs++;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"engines":'));
                },
              }),
            );
          },
        ),
      ),
      Effect.scoped,
    );
  });

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
      expect(error._tag).toBe("SearchProviderError");
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

  it.effect("keeps successful empty results when only some engines failed", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      expect(yield* backend.search(connection, { query: "x", maxResults: 5 })).toEqual([]);
    }).pipe(
      Effect.provide(
        backendWith((url) => {
          expect(url.searchParams.get("engines")).toBe("brave,google,startpage");
          return Response.json({ results: [], unresponsive_engines: [["brave", "CAPTCHA"]] });
        }),
      ),
    ),
  );

  it.effect("does not claim total outage when configuration is unavailable", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      expect(yield* backend.search(connection, { query: "x", maxResults: 5 })).toEqual([]);
    }).pipe(
      Effect.provide(
        backendWith(
          (url) => {
            expect(url.searchParams.has("engines")).toBe(false);
            return Response.json({ results: [], unresponsive_engines: [["brave", "CAPTCHA"]] });
          },
          () => new Response(null, { status: 403 }),
        ),
      ),
    ),
  );

  it.effect("excludes disabled, non-general and unsupported time-range engines", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const error = yield* backend
        .search(connection, { query: "x", maxResults: 5, timeRange: "month" })
        .pipe(Effect.flip);
      expect(error.message).toContain("search engines unavailable");
    }).pipe(
      Effect.provide(
        backendWith(
          (url) => {
            expect(url.searchParams.get("engines")).toBe("brave");
            return Response.json({
              results: [],
              unresponsive_engines: [["brave", "Suspended: CAPTCHA"]],
            });
          },
          () =>
            Response.json({
              engines: [
                { name: "brave", enabled: true, categories: ["general"], time_range_support: true },
                {
                  name: "disabled",
                  enabled: false,
                  categories: ["general"],
                  time_range_support: true,
                },
                { name: "images", enabled: true, categories: ["images"], time_range_support: true },
                {
                  name: "timeless",
                  enabled: true,
                  categories: ["general"],
                  time_range_support: false,
                },
              ],
            }),
        ),
      ),
    ),
  );

  it.effect("leaves bang-selected participation unknown", () =>
    Effect.gen(function* () {
      const backend = yield* SearchBackend;
      expect(yield* backend.search(connection, { query: "!brave x", maxResults: 5 })).toEqual([]);
    }).pipe(
      Effect.provide(
        backendWith(
          (url) => {
            expect(url.searchParams.has("engines")).toBe(false);
            return Response.json({ results: [], unresponsive_engines: [["brave", "CAPTCHA"]] });
          },
          () => {
            throw new Error("bang queries must not infer participation from defaults");
          },
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
      expect(error._tag).toBe("SearchProviderError");
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

describe("SearxngBackend images", () => {
  it.effect("asks the image engines and keeps only fetchable http(s) images", () => {
    let asked: URL | undefined;
    return Effect.gen(function* () {
      const backend = yield* SearchBackend;
      const hits = yield* backend.searchImages!(connection, { query: "gear hub", maxResults: 2 });
      expect(asked?.searchParams.get("engines")).toBe("bing images");
      expect(hits).toEqual([
        {
          imageUrl: "https://img.example/a.jpg",
          thumbnailUrl: "https://thumbs.example/a.jpg",
          pageUrl: "https://page.example/a",
          title: "A",
          width: 1920,
          height: 1080,
        },
        {
          imageUrl: "https://img.example/b.png",
          pageUrl: "https://page.example/b",
          title: "https://page.example/b",
        },
      ]);
    }).pipe(
      Effect.provide(
        backendWith(
          (url) => {
            asked = url;
            return searxngJson([
              {
                url: "https://page.example/a",
                title: "A",
                img_src: "https://img.example/a.jpg",
                thumbnail_src: "//thumbs.example/a.jpg",
                resolution: "1920 x 1080",
              },
              // The same image from a second engine.
              { url: "https://page.example/a2", img_src: "https://img.example/a.jpg" },
              { url: "https://page.example/data", img_src: "data:image/png;base64,AAAA" },
              {
                url: "https://page.example/b",
                img_src: "https://img.example/b.png",
                resolution: "big",
              },
              { url: "https://page.example/c", img_src: "https://img.example/c.png" },
              { url: "https://page.example/d", img_src: "https://img.example/d.png" },
            ]);
          },
          () =>
            Response.json({
              engines: [
                { name: "brave", enabled: true, categories: ["general"], time_range_support: true },
                {
                  name: "bing images",
                  enabled: true,
                  categories: ["images"],
                  time_range_support: false,
                },
              ],
            }),
        ),
      ),
    );
  });
});
