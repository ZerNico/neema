import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, type SearchHit } from "./search.ts";
import {
  WebSearchExecutor,
  type WebSearchResult,
  type WebSearchToolkitWithHandler,
} from "./web-search.ts";

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

const TestLayer = WebSearchExecutor.layer.pipe(
  Layer.provide(Layer.mergeAll(FakeRepo, FakeBackend, FakeExtractor)),
);

// Runs a query through a prepared toolkit and returns the final result —
// `handle` streams the handler's preliminary progress ahead of the real one.
const runQuery = (toolkit: WebSearchToolkitWithHandler, query: string) =>
  Effect.gen(function* () {
    const stream = yield* toolkit.handle("web_search", { query });
    const parts = yield* Stream.runCollect(stream);
    return parts[parts.length - 1]!.result as WebSearchResult;
  });

describe("WebSearchExecutor citation numbering", () => {
  it.effect("numbers sources per generation, not per call", () =>
    Effect.gen(function* () {
      const executor = yield* WebSearchExecutor;
      // One prepare() per assistant message — both searches share its counter.
      const toolkit = yield* executor.prepare();

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

  it.effect("marks fetched pages as read and the rest as snippet-only", () =>
    Effect.gen(function* () {
      const executor = yield* WebSearchExecutor;
      const toolkit = yield* executor.prepare();
      const result = yield* runQuery(toolkit, "first");
      // maxPagesFetched is 1, so only the first hit is read in full.
      expect(result.sources?.map((s) => s.read)).toEqual([true, false]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
