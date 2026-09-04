import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { Toolkit } from "effect/unstable/ai";
import { PageExtractionError, PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, type SearchHit } from "./search.ts";
import { createSourceIndexer, type SourceIndexer } from "./source-indexer.ts";
import { prepareWebToolkit } from "./toolset.ts";
import { createUrlAuthority } from "./url-authority.ts";
import { UrlReaderExecutor } from "./url-reader.ts";
import { WebSearchExecutor, type WebToolResult } from "./web-search.ts";

const searchConfig = {
  backend: "searxng" as const,
  baseUrl: "http://localhost:8081",
  maxResults: 5,
};

const FakeRepo = (readerEnabled: boolean) =>
  Layer.succeed(
    ToolsRepo,
    ToolsRepo.of({
      getTool: () => Effect.succeed(null),
      getWebSearch: () => Effect.succeed({ enabled: true, config: searchConfig, secret: null }),
      getDocumentParser: () => Effect.succeed(null),
      getUrlReader: () =>
        Effect.succeed({ enabled: readerEnabled, config: { perPageCharCap: 20_000 } }),
      setToolEnabled: () => Effect.succeed({ tool: null, changed: false }),
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

const RejectingExtractor = Layer.succeed(
  PageExtractor,
  PageExtractor.of({
    extract: () => Effect.die("disallowed URL reached the extractor"),
  }),
);

const LargeExtractor = Layer.succeed(
  PageExtractor,
  PageExtractor.of({
    extract: (input) =>
      Effect.succeed({
        url: input.url,
        title: "Large page",
        content: "x".repeat(20_000),
        truncated: false,
      }),
  }),
);

const layers = (readerEnabled: boolean, extractor = FakeExtractor) =>
  Layer.mergeAll(WebSearchExecutor.layer, UrlReaderExecutor.layer).pipe(
    Layer.provide(Layer.mergeAll(FakeRepo(readerEnabled), FakeBackend, extractor)),
  );

const prepared = (
  indexer: SourceIndexer,
  authorityUrls: ReadonlyArray<string>,
  requestSearch = true,
) =>
  Effect.gen(function* () {
    return yield* prepareWebToolkit({
      webSearch: yield* WebSearchExecutor,
      urlReader: yield* UrlReaderExecutor,
      indexer,
      authority: createUrlAuthority(authorityUrls),
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
  it.effect("reads several pages in one call and cites redirect destinations", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([]), [
        "https://blog.example/moved",
        "https://docs.example/start",
      ]))!.toolkit;
      const results = yield* runTool(toolkit, "read_url", {
        urls: ["https://blog.example/moved", "https://docs.example/start"],
      });

      expect(results.length).toBeGreaterThan(1);
      const final = results.at(-1)!;
      expect(final.ok).toBe(true);
      expect(final.pagesFetched).toBe(2);
      expect(final.results.map((result) => result.url)).toEqual([
        "https://blog.example/final",
        "https://docs.example/start",
      ]);
      expect(final.sources?.map((source) => source.index)).toEqual([1, 2]);
      expect(final.failures).toEqual([]);
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("enforces the aggregate character budget fairly across a full batch", () =>
    Effect.gen(function* () {
      const urls = Array.from({ length: 5 }, (_, index) => `https://large${index}.example/`);
      const toolkit = (yield* prepared(createSourceIndexer([]), urls, false))!.toolkit;
      const final = (yield* runTool(toolkit, "read_url", { urls })).at(-1)!;

      expect(final.results).toHaveLength(5);
      expect(
        final.results.reduce((total, result) => total + (result.content?.length ?? 0), 0),
      ).toBeLessThanOrEqual(60_000);
      expect(final.results.every((result) => result.truncated)).toBe(true);
    }).pipe(Effect.provide(layers(true, LargeExtractor))),
  );

  it.effect("falls back to the hostname when a page has no title", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(
        createSourceIndexer([]),
        ["https://untitled.example/x"],
        false,
      ))!.toolkit;
      const final = (yield* runTool(toolkit, "read_url", {
        urls: ["https://untitled.example/x"],
      })).at(-1)!;
      expect(final.sources?.[0]).toMatchObject({ title: "untitled.example" });
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("keeps successful pages and returns each failed URL's reason", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(
        createSourceIndexer([]),
        ["https://good.example/", "https://boom.example/"],
        false,
      ))!.toolkit;
      const final = (yield* runTool(toolkit, "read_url", {
        urls: ["https://good.example/", "https://boom.example/"],
      })).at(-1)!;

      expect(final.ok).toBe(true);
      expect(final.pagesFetched).toBe(1);
      expect(final.failures).toEqual([
        { target: "https://boom.example/", error: "fetch failed: 503" },
      ]);
      expect(final.pages?.find((page) => page.url === "https://boom.example/")).toMatchObject({
        status: "error",
        error: "fetch failed: 503",
      });
      expect(final.error).toContain("https://boom.example/");
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("opens a result URL after web_search grants authority", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([]), [], true))!.toolkit;

      const search = (yield* runTool(toolkit, "web_search", { queries: ["effect libraries"] })).at(
        -1,
      )!;
      expect(search.sources?.map((source) => source.index)).toEqual([1, 2]);

      const read = (yield* runTool(toolkit, "read_url", { urls: ["https://drizzle.team"] })).at(
        -1,
      )!;
      expect(read.ok).toBe(true);
      expect(read.sources?.[0]?.index).toBe(2);
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("stays out of the toolkit while disabled, leaving search alone", () =>
    Effect.gen(function* () {
      const preparedToolkit = yield* prepared(createSourceIndexer([]), [], true);
      expect(preparedToolkit?.tools).toEqual({ search: true, reader: false });
    }).pipe(Effect.provide(layers(false))),
  );

  it.effect("is omitted when neither search nor seeded URL authority applies", () =>
    Effect.gen(function* () {
      expect(yield* prepared(createSourceIndexer([]), [], false)).toBeUndefined();
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("is armed for user URLs without enabling search", () =>
    Effect.gen(function* () {
      const preparedToolkit = yield* prepared(
        createSourceIndexer([]),
        ["https://blog.example/x"],
        false,
      );
      expect(preparedToolkit?.tools).toEqual({ search: false, reader: true });

      const final = (yield* runTool(preparedToolkit!.toolkit, "read_url", {
        urls: ["https://blog.example/x"],
      })).at(-1)!;
      expect(final.sources?.[0]).toMatchObject({ index: 1, url: "https://blog.example/x" });
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("accepts canonical equivalents of authority URLs", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(createSourceIndexer([]), ["https://blog.example/x"], false))!
        .toolkit;
      const final = (yield* runTool(toolkit, "read_url", {
        urls: ["https://blog.example:443/x#section"],
      })).at(-1)!;

      expect(final.ok).toBe(true);
      expect(final.targets).toEqual(["https://blog.example:443/x#section"]);
      expect(final.sources?.[0]?.url).toBe("https://blog.example/x");
    }).pipe(Effect.provide(layers(true))),
  );

  it.effect("rejects an entirely invented batch before invoking the extractor", () =>
    Effect.gen(function* () {
      const toolkit = (yield* prepared(
        createSourceIndexer([]),
        ["https://allowed.example/"],
        false,
      ))!.toolkit;
      const final = (yield* runTool(toolkit, "read_url", {
        urls: ["https://invented.example/", "https://also-invented.example/"],
      })).at(-1)!;

      expect(final.ok).toBe(false);
      expect(final.pagesFetched).toBe(0);
      expect(final.failures).toHaveLength(2);
      expect(final.error).toContain("user message or from this conversation's search results");
    }).pipe(Effect.provide(layers(true, RejectingExtractor))),
  );
});
