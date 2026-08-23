import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { Toolkit } from "effect/unstable/ai";
import { PageExtractionError, PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, type SearchHit } from "./search.ts";
import { createSourceIndexer, type SourceIndexer } from "./source-indexer.ts";
import { prepareWebToolkit } from "./toolset.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor, type WebToolResult } from "./web-search.ts";

const searchConfig = {
  backend: "searxng" as const,
  baseUrl: "http://localhost:8081",
  maxResults: 5,
  maxPagesFetched: 1,
  perPageCharCap: 1000,
};

const FakeRepo = (readerEnabled: boolean) =>
  Layer.succeed(
    ToolsRepo,
    ToolsRepo.of({
      getTool: () => Effect.succeed(null),
      getWebSearch: () => Effect.succeed({ enabled: true, config: searchConfig, secret: null }),
      getDocumentParser: () => Effect.succeed(null),
      getUrlReader: () =>
        Effect.succeed({ enabled: readerEnabled, config: { perPageCharCap: 1000 } }),
      updateTool: () => Effect.succeed(null),
    }),
  );

const hit = (url: string): SearchHit => ({ url, title: `Title of ${url}`, snippet: "snippet" });

const FakeBackend = Layer.succeed(
  SearchBackend,
  SearchBackend.of({
    kind: "fake",
    search: () => Effect.succeed([hit("https://effect.website"), hit("https://drizzle.team")]),
    test: () => Effect.succeed({ resultCount: 0 }),
  }),
);

// Redirect simulation: pages under /moved extract at a different final URL.
const FakeExtractor = Layer.succeed(
  PageExtractor,
  PageExtractor.of({
    extract: (input) =>
      input.url.includes("boom")
        ? Effect.fail(new PageExtractionError({ url: input.url, message: "fetch failed: 503" }))
        : Effect.succeed({
            url: input.url.replace("/moved", "/final"),
            title: input.url.includes("untitled") ? null : "A Page Title",
            content: "# Heading\n\nThe extracted body of the page.",
            truncated: false,
          }),
  }),
);

const layers = (readerEnabled: boolean) =>
  Layer.mergeAll(WebSearchExecutor.layer, UrlReaderExecutor.layer).pipe(
    Layer.provide(Layer.mergeAll(FakeRepo(readerEnabled), FakeBackend, FakeExtractor)),
  );

const prepared = (indexer: SourceIndexer, requestSearch = true) =>
  Effect.gen(function* () {
    return yield* prepareWebToolkit({
      webSearch: yield* WebSearchExecutor,
      urlReader: yield* UrlReaderExecutor,
      indexer,
      requestSearch,
    });
  });

const runTool = (toolkit: Toolkit.WithHandler<any>, name: string, params: object) =>
  Effect.gen(function* () {
    const stream = yield* toolkit.handle(
      name as never,
      params as never,
    ) as unknown as Effect.Effect<Stream.Stream<{ result: unknown; preliminary?: boolean }>>;
    const parts = yield* Stream.runCollect(stream);
    return [...parts].map((part) => part.result as WebToolResult);
  });

describe("UrlReaderExecutor", () => {
  it.effect("reads a page into the shared result shape, citing the final URL", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([])))!.toolkit;
      const results = yield* runTool(toolkit, "read_url", { url: "https://blog.example/moved" });

      // Preliminary "reading" progress first, then the real result.
      expect(results.length).toBeGreaterThan(1);
      expect(results[0]!.pages).toEqual([{ url: "https://blog.example/moved", status: "reading" }]);

      const final = results.at(-1)!;
      expect(final.ok).toBe(true);
      expect(final.results[0]).toMatchObject({
        index: 1,
        url: "https://blog.example/final",
        title: "A Page Title",
        content: "# Heading\n\nThe extracted body of the page.",
        snippet: "Heading",
      });
      expect(final.sources).toEqual([
        {
          index: 1,
          url: "https://blog.example/final",
          title: "A Page Title",
          snippet: "Heading",
          read: true,
        },
      ]);
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("falls back to the hostname when the page has no title", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([])))!.toolkit;
      const results = yield* runTool(toolkit, "read_url", { url: "https://untitled.example/x" });
      expect(results.at(-1)!.sources?.[0]).toMatchObject({ title: "untitled.example" });
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("returns a model-readable failure when extraction fails", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([])))!.toolkit;
      const results = yield* runTool(toolkit, "read_url", { url: "https://boom.example/" });
      const final = results.at(-1)!;
      expect(final).toMatchObject({ ok: false, error: "fetch failed: 503" });
      expect(final.pages).toEqual([{ url: "https://boom.example/", status: "error" }]);
      expect(final.sources).toBeUndefined();
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("shares one citation sequence with web_search", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([])))!.toolkit;

      // Search assigns 1 + 2; a read of a NEW page continues with 3.
      const search = (yield* runTool(toolkit, "web_search", { query: "anything" })).at(-1)!;
      expect(search.sources?.map((s) => s.index)).toEqual([1, 2]);

      const fresh = (yield* runTool(toolkit, "read_url", { url: "https://tanstack.com" })).at(-1)!;
      expect(fresh.sources?.[0]?.index).toBe(3);

      // Reading a page the search already indexed reuses its number.
      const repeat = (yield* runTool(toolkit, "read_url", { url: "https://effect.website" })).at(
        -1,
      )!;
      expect(repeat.sources?.[0]?.index).toBe(1);
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("stays out of the toolkit while disabled, leaving search alone", () =>
    Effect.gen(function* () {
      const preparedToolkit = yield* prepared(createSourceIndexer([]));
      expect(preparedToolkit?.tools).toEqual({ search: true, reader: false });
    }).pipe(Effect.provide(layers(false))),
  );

  // The reader is not a mode the user opts into: an admin enabling it is the
  // only gate, so it must be armed on a generation that never asked to search.
  it.effect("is armed without the search toggle, and search is not", () =>
    Effect.gen(function* () {
      const preparedToolkit = yield* prepared(createSourceIndexer([]), false);
      expect(preparedToolkit?.tools).toEqual({ search: false, reader: true });

      const results = yield* runTool(preparedToolkit!.toolkit, "read_url", {
        url: "https://blog.example/x",
      });
      expect(results.at(-1)!.sources?.[0]?.index).toBe(1);
    }).pipe(Effect.provide(layers(true))),
  );

  // Neither tool applies: the stream engine then runs with no toolkit at all.
  it.effect("yields no toolkit when search is unasked and the reader is off", () =>
    Effect.gen(function* () {
      expect(yield* prepared(createSourceIndexer([]), false)).toBeUndefined();
    }).pipe(Effect.provide(layers(false))),
  );
});
