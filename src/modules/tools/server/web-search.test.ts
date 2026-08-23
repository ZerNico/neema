import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { Toolkit } from "effect/unstable/ai";
import { PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, type SearchHit } from "./search.ts";
import { createSourceIndexer, type SourceIndexer } from "./source-indexer.ts";
import { prepareWebToolkit } from "./toolset.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor, type WebToolResult } from "./web-search.ts";

const config = {
  backend: "searxng" as const,
  baseUrl: "http://localhost:8081",
  maxResults: 5,
  maxPagesFetched: 1,
  perPageCharCap: 1000,
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

// Two searches: the second repeats effect.website and adds a new host.
const resultsByQuery: Record<string, SearchHit[]> = {
  first: [hit("https://effect.website"), hit("https://drizzle.team")],
  second: [hit("https://effect.website"), hit("https://tanstack.com")],
};

const FakeBackend = Layer.succeed(
  SearchBackend,
  SearchBackend.of({
    kind: "fake",
    search: (_connection, request) => Effect.succeed(resultsByQuery[request.query] ?? []),
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

// The reader row is null in FakeRepo, so this builds a search-only toolkit.
const prepared = (indexer: SourceIndexer) =>
  Effect.gen(function* () {
    const result = yield* prepareWebToolkit({
      webSearch: yield* WebSearchExecutor,
      urlReader: yield* UrlReaderExecutor,
      indexer,
      requestSearch: true,
    });
    return result!.toolkit;
  });

// Runs a query through a prepared toolkit and returns the final result —
// `handle` streams the handler's preliminary progress ahead of the real one.
const runQuery = (toolkit: Toolkit.WithHandler<any>, query: string) =>
  Effect.gen(function* () {
    // WithHandler<any> widens handle's requirements to unknown; the concrete
    // toolkit needs none, so pin the type for it.effect's Scope context.
    const stream = yield* toolkit.handle("web_search", { query }) as unknown as Effect.Effect<
      Stream.Stream<{ result: unknown }>
    >;
    const parts = yield* Stream.runCollect(stream);
    return [...parts].at(-1)!.result as WebToolResult;
  });

describe("WebSearchExecutor citation numbering", () => {
  it.effect("numbers sources per generation, not per call", () =>
    Effect.gen(function* () {
      // One indexer per generation — both searches share its counter.
      const toolkit = yield* prepared(createSourceIndexer([]));

      const first = yield* runQuery(toolkit, "first");
      const second = yield* runQuery(toolkit, "second");

      expect(first.sources?.map((s) => [s.index, s.url])).toEqual([
        [1, "https://effect.website"],
        [2, "https://drizzle.team"],
      ]);
      // Continues the sequence, and the repeated URL keeps its original number.
      expect(second.sources?.map((s) => [s.index, s.url])).toEqual([
        [1, "https://effect.website"],
        [3, "https://tanstack.com"],
      ]);
      // The model sees the same numbers on the results it reads.
      expect(second.results.map((r) => r.index)).toEqual([1, 3]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("continues numbering from a conversation seed and reuses seeded URLs", () =>
    Effect.gen(function* () {
      // A later generation in the same conversation: earlier messages already
      // used indexes 1–5, and effect.website was index 2.
      const toolkit = yield* prepared(
        createSourceIndexer([
          { index: 2, url: "https://effect.website" },
          { index: 5, url: "https://old.example" },
        ]),
      );

      const result = yield* runQuery(toolkit, "first");
      expect(result.sources?.map((s) => [s.index, s.url])).toEqual([
        [2, "https://effect.website"],
        [6, "https://drizzle.team"],
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("marks fetched pages as read and the rest as snippet-only", () =>
    Effect.gen(function* () {
      const toolkit = yield* prepared(createSourceIndexer([]));
      const result = yield* runQuery(toolkit, "first");
      // maxPagesFetched is 1, so only the first hit is read in full.
      expect(result.sources?.map((s) => s.read)).toEqual([true, false]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
