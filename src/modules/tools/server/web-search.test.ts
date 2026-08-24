import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { Toolkit } from "effect/unstable/ai";
import { PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, SearchBackendError, type SearchHit } from "./search.ts";
import { createSourceIndexer, type SourceIndexer } from "./source-indexer.ts";
import { prepareWebToolkit } from "./toolset.ts";
import { createUrlAuthority } from "./url-authority.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor, type WebToolResult } from "./web-search.ts";

const config = {
  backend: "searxng" as const,
  baseUrl: "http://localhost:8081",
  maxResults: 5,
};

const FakeRepo = Layer.succeed(
  ToolsRepo,
  ToolsRepo.of({
    getTool: () => Effect.succeed(null),
    getWebSearch: () => Effect.succeed({ enabled: true, config, secret: null }),
    getDocumentParser: () => Effect.succeed(null),
    getUrlReader: () => Effect.succeed(null),
    updateTool: () => Effect.succeed(null),
  }),
);

const hit = (url: string): SearchHit => ({ url, title: `Title of ${url}`, snippet: "snippet" });

const resultsByQuery: Record<string, SearchHit[]> = {
  first: [hit("https://effect.website"), hit("https://drizzle.team")],
  second: [hit("https://effect.website"), hit("https://tanstack.com")],
  alpha: [hit("https://a.example"), hit("https://shared.example")],
  beta: [hit("https://shared.example/"), hit("https://b.example")],
};

const FakeBackend = Layer.succeed(
  SearchBackend,
  SearchBackend.of({
    kind: "fake",
    search: (_connection, request) =>
      request.query === "broken"
        ? Effect.fail(new SearchBackendError({ backend: "fake", message: "backend unavailable" }))
        : Effect.succeed(resultsByQuery[request.query] ?? []),
    test: () => Effect.succeed({ resultCount: 0 }),
  }),
);

const FakeExtractor = Layer.succeed(
  PageExtractor,
  PageExtractor.of({
    extract: (input) =>
      Effect.succeed({ url: input.url, title: null, content: "body", truncated: false }),
  }),
);

const TestLayer = Layer.mergeAll(WebSearchExecutor.layer, UrlReaderExecutor.layer).pipe(
  Layer.provide(Layer.mergeAll(FakeRepo, FakeBackend, FakeExtractor)),
);

const prepared = (indexer: SourceIndexer) =>
  Effect.gen(function* () {
    const result = yield* prepareWebToolkit({
      webSearch: yield* WebSearchExecutor,
      urlReader: yield* UrlReaderExecutor,
      indexer,
      authority: createUrlAuthority([]),
      requestSearch: true,
    });
    return result!.toolkit;
  });

const runSearch = (toolkit: Toolkit.WithHandler<any>, queries: string[]) =>
  Effect.gen(function* () {
    const stream = yield* toolkit.handle("web_search", { queries }) as unknown as Effect.Effect<
      Stream.Stream<{ result: unknown }>
    >;
    const parts = yield* Stream.runCollect(stream);
    return [...parts].at(-1)!.result as WebToolResult;
  });

describe("WebSearchExecutor", () => {
  it.effect("numbers sources per generation, not per call", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(createSourceIndexer([]));

      const first = yield* runSearch(toolkit, ["first"]);
      const second = yield* runSearch(toolkit, ["second"]);

      expect(first.sources?.map((source) => [source.index, source.url])).toEqual([
        [1, "https://effect.website/"],
        [2, "https://drizzle.team/"],
      ]);
      expect(second.sources?.map((source) => [source.index, source.url])).toEqual([
        [1, "https://effect.website/"],
        [3, "https://tanstack.com/"],
      ]);
      expect(second.results.map((result) => result.index)).toEqual([1, 3]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("continues numbering from a conversation seed", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(
        createSourceIndexer([
          { index: 2, url: "https://effect.website" },
          { index: 5, url: "https://old.example" },
        ]),
      );

      const result = yield* runSearch(toolkit, ["first"]);
      expect(result.sources?.map((source) => [source.index, source.url])).toEqual([
        [2, "https://effect.website/"],
        [6, "https://drizzle.team/"],
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("returns snippets only and never invokes page extraction", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(createSourceIndexer([]));
      const result = yield* runSearch(toolkit, ["first"]);

      expect(result.pagesFetched).toBe(0);
      expect(result.pages).toBeUndefined();
      expect(result.results.every((item) => item.content === undefined)).toBe(true);
      expect(result.sources?.map((source) => source.read)).toEqual([false, false]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("merges multiple queries round-robin and deduplicates canonical URLs", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(createSourceIndexer([]));
      const result = yield* runSearch(toolkit, ["alpha", "beta"]);

      expect(result.targets).toEqual(["alpha", "beta"]);
      expect(result.results.map((item) => item.url)).toEqual([
        "https://a.example/",
        "https://shared.example/",
        "https://b.example/",
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps successful queries when one backend call fails", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(createSourceIndexer([]));
      const result = yield* runSearch(toolkit, ["broken", "first"]);

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.failures).toEqual([{ target: "broken", error: "backend unavailable" }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
