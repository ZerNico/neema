import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream, Semaphore } from "effect";
import type { Toolkit } from "effect/unstable/ai";
import { PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend, SearchBackendError, type SearchHit, type SearchRequest } from "./search.ts";
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
    setToolEnabled: () => Effect.succeed({ tool: null, changed: false }),
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
  it.effect("uses 80 research queries for legacy config without a saved cap", () =>
    Effect.gen(function* () {
      const executor = yield* WebSearchExecutor;
      expect(yield* executor.researchSearchLimit()).toBe(80);
    }).pipe(Effect.provide(TestLayer)),
  );

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

describe("per-run search cache", () => {
  it.effect("answers a repeated query from the handler's own cache and charges no budget", () =>
    Effect.gen(function* () {
      let calls = 0;
      let admitted = 0;
      const counted = Layer.succeed(
        SearchBackend,
        SearchBackend.of({
          kind: "fake",
          test: () => Effect.succeed({ resultCount: 0 }),
          search: (_connection, request) =>
            Effect.sync(() => {
              calls++;
              return request.query === "broken" ? [] : [hit(`https://${request.query}.example`)];
            }),
        }),
      );
      const layer = WebSearchExecutor.layer.pipe(Layer.provide(Layer.mergeAll(FakeRepo, counted)));
      const executor = yield* WebSearchExecutor.pipe(Effect.provide(layer));
      const policy = {
        admit: (_kind: "search" | "read", count: number) => {
          admitted += count;
          return true;
        },
        run: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      };
      const handler = yield* executor.handler(
        createSourceIndexer([]),
        createUrlAuthority([]),
        policy,
      );
      const first = yield* handler({ queries: ["alpha", "beta"] });
      // Another worker asking the same thing with one new query: only the new
      // query reaches the backend or the budget.
      const second = yield* handler({ queries: ["beta", "gamma", "alpha"] });
      expect(calls).toBe(3);
      expect(admitted).toBe(3);
      expect(second.ok).toBe(true);
      expect(second.results.map((result) => result.url)).toEqual([
        "https://beta.example/",
        "https://gamma.example/",
        "https://alpha.example/",
      ]);
      // Numbering is stable across the repeat.
      expect(second.sources?.find((source) => source.url === "https://alpha.example/")?.index).toBe(
        first.sources?.find((source) => source.url === "https://alpha.example/")?.index,
      );
      // A fully cached call is never refused by an exhausted budget.
      const refusing = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
        ...policy,
        admit: () => false,
      });
      expect((yield* refusing({ queries: ["alpha"] })).ok).toBe(false);
      expect((yield* handler({ queries: ["alpha"] })).ok).toBe(true);
      expect(calls).toBe(3);
      // The time range is part of the key: a narrower search is a new request.
      yield* handler({ queries: ["alpha"], timeRange: "month" });
      expect(calls).toBe(4);
      // Different handlers are different runs and share nothing.
      const other = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]));
      yield* other({ queries: ["alpha"] });
      expect(calls).toBe(5);
    }),
  );
});

interface PendingRequest {
  request: SearchRequest;
  reply: Deferred.Deferred<ReadonlyArray<SearchHit>, SearchBackendError>;
  interrupted: Deferred.Deferred<void>;
}

// Each queue item proves that an actual request reached the backend. Tests
// release responses explicitly; no network or clock-based coordination.
const controlledBackend = Effect.fnUntraced(function* (cleanup: Effect.Effect<void> = Effect.void) {
  const requests = yield* Queue.unbounded<PendingRequest>();
  const calls: PendingRequest[] = [];
  const backend = SearchBackend.of({
    kind: "fake",
    test: () => Effect.succeed({ resultCount: 0 }),
    search: (_connection, request) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<ReadonlyArray<SearchHit>, SearchBackendError>();
        const interrupted = yield* Deferred.make<void>();
        const call = { request, reply, interrupted };
        calls.push(call);
        yield* Queue.offer(requests, call);
        return yield* Deferred.await(reply).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          Effect.ensuring(cleanup),
        );
      }),
  });
  const executor = yield* WebSearchExecutor.pipe(
    Effect.provide(
      WebSearchExecutor.layer.pipe(
        Layer.provide(Layer.mergeAll(FakeRepo, Layer.succeed(SearchBackend, backend))),
      ),
    ),
  );
  return { executor, requests, calls };
});

const start = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkChild(effect, { startImmediately: true });

// Let forEach's child fibers attach before exercising cancellation/completion.
const settleWaiters = Effect.yieldNow;

describe("single-flight search", () => {
  it.effect(
    "shares one request, admission, permit and observation; caches successful empty results",
    () =>
      Effect.gen(function* () {
        const { executor, requests, calls } = yield* controlledBackend();
        let admitted = 0;
        let permits = 0;
        const observed: boolean[] = [];
        const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
          admit: (_kind, targets) => {
            admitted += targets;
            return true;
          },
          run: (effect) =>
            Effect.sync(() => {
              permits++;
            }).pipe(Effect.andThen(effect)),
          observeSearch: (ok) => {
            observed.push(ok);
          },
        });
        const first = yield* start(handler({ queries: ["same"] }));
        const request = yield* Queue.take(requests);
        const second = yield* start(handler({ queries: ["same", " same "] }));
        yield* settleWaiters;
        expect(calls).toHaveLength(1);
        expect(admitted).toBe(1);
        expect(permits).toBe(1);
        yield* Deferred.succeed(request.reply, []);
        expect((yield* Fiber.join(first)).ok).toBe(true);
        expect((yield* Fiber.join(second)).ok).toBe(true);
        const cached = yield* handler({ queries: ["same"] });
        expect(cached.ok).toBe(true);
        expect(cached.results).toEqual([]);
        expect(calls).toHaveLength(1);
        expect(admitted).toBe(1);
        expect(permits).toBe(1);
        expect(observed).toEqual([true]);
      }),
  );

  it.effect("shares a safe typed failure, evicts it and observes a real retry once", () =>
    Effect.gen(function* () {
      const { executor, requests, calls } = yield* controlledBackend();
      const observed: boolean[] = [];
      const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
        admit: () => true,
        run: (effect) => effect,
        observeSearch: (ok) => {
          observed.push(ok);
        },
      });
      const first = yield* start(handler({ queries: ["same"] }));
      const failed = yield* Queue.take(requests);
      const second = yield* start(handler({ queries: ["same"] }));
      yield* settleWaiters;
      yield* Deferred.fail(
        failed.reply,
        new SearchBackendError({ backend: "fake", message: "backend unavailable" }),
      );
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      expect(a).toEqual(b);
      expect(a.failures).toEqual([{ target: "same", error: "backend unavailable" }]);
      expect(a.ok).toBe(false);
      expect(observed).toEqual([false]);
      const retry = yield* start(handler({ queries: ["same"] }));
      yield* Deferred.succeed((yield* Queue.take(requests)).reply, [hit("https://retry.example")]);
      expect((yield* Fiber.join(retry)).ok).toBe(true);
      yield* handler({ queries: ["same"] });
      expect(calls).toHaveLength(2);
      expect(observed).toEqual([false, true]);
    }),
  );

  it.effect("shares defects without outage observations and evicts the broken flight", () =>
    Effect.gen(function* () {
      const { executor, requests, calls } = yield* controlledBackend();
      const observed: boolean[] = [];
      const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
        admit: () => true,
        run: (effect) => effect,
        observeSearch: (ok) => {
          observed.push(ok);
        },
      });
      const first = yield* start(handler({ queries: ["same"] }));
      const request = yield* Queue.take(requests);
      const second = yield* start(handler({ queries: ["same"] }));
      yield* settleWaiters;
      yield* Deferred.die(request.reply, new Error("broken implementation"));
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
      expect(observed).toEqual([]);
      const retry = yield* start(handler({ queries: ["same"] }));
      yield* Deferred.succeed((yield* Queue.take(requests)).reply, []);
      expect((yield* Fiber.join(retry)).ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(observed).toEqual([true]);
    }),
  );

  it.effect("completes waiters even when the owning scope closes before a producer can start", () =>
    Effect.gen(function* () {
      const { executor, calls } = yield* controlledBackend();
      const scope = yield* Scope.make();
      const handler = yield* executor
        .handler(createSourceIndexer([]), createUrlAuthority([]))
        .pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      const outcome = yield* Effect.exit(handler({ queries: ["same"] }));
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("detaches one cancelled waiter without cancelling another", () =>
    Effect.gen(function* () {
      const { executor, requests, calls } = yield* controlledBackend();
      const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]));
      const first = yield* start(handler({ queries: ["same"] }));
      const request = yield* Queue.take(requests);
      const second = yield* start(handler({ queries: ["same"] }));
      yield* settleWaiters;
      yield* Fiber.interrupt(first);
      expect(yield* Deferred.isDone(request.interrupted)).toBe(false);
      yield* Deferred.succeed(request.reply, [hit("https://shared.example")]);
      expect((yield* Fiber.join(second)).results).toHaveLength(1);
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect(
    "interrupts the last waiter's producer and does not let old cleanup evict a replacement",
    () =>
      Effect.gen(function* () {
        const cleanup = yield* Deferred.make<void>();
        const { executor, requests, calls } = yield* controlledBackend(Deferred.await(cleanup));
        const observed: boolean[] = [];
        const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
          admit: () => true,
          run: (effect) => effect,
          observeSearch: (ok) => {
            observed.push(ok);
          },
        });
        const first = yield* start(handler({ queries: ["same"] }));
        const abandoned = yield* Queue.take(requests);
        const cancelling = yield* start(Fiber.interrupt(first));
        yield* Deferred.await(abandoned.interrupted);
        const retry = yield* start(handler({ queries: ["same"] }));
        const replacement = yield* Queue.take(requests);
        // The old producer completes after a replacement is already in the map.
        yield* Deferred.succeed(cleanup, undefined);
        yield* Fiber.join(cancelling);
        const another = yield* start(handler({ queries: ["same"] }));
        yield* settleWaiters;
        expect(calls).toHaveLength(2);
        yield* Deferred.succeed(replacement.reply, [hit("https://replacement.example")]);
        expect((yield* Fiber.join(retry)).ok).toBe(true);
        expect((yield* Fiber.join(another)).ok).toBe(true);
        expect((yield* handler({ queries: ["same"] })).ok).toBe(true);
        expect(calls).toHaveLength(2);
        expect(observed).toEqual([true]);
      }),
  );

  it.effect(
    "closing the generation scope interrupts all producers, wakes waiters and releases permits",
    () =>
      Effect.gen(function* () {
        const { executor, requests } = yield* controlledBackend();
        const scope = yield* Scope.make();
        const semaphore = yield* Semaphore.make(2);
        const observed: boolean[] = [];
        const handler = yield* executor
          .handler(createSourceIndexer([]), createUrlAuthority([]), {
            admit: () => true,
            run: (effect) => semaphore.withPermits(1)(effect),
            observeSearch: (ok) => {
              observed.push(ok);
            },
          })
          .pipe(Scope.provide(scope));
        const first = yield* start(handler({ queries: ["first"] }));
        const a = yield* Queue.take(requests);
        const second = yield* start(handler({ queries: ["second"] }));
        const b = yield* Queue.take(requests);
        const shared = yield* start(handler({ queries: ["first"] }));
        yield* settleWaiters;
        yield* Scope.close(scope, Exit.void);
        expect(yield* Deferred.isDone(a.interrupted)).toBe(true);
        expect(yield* Deferred.isDone(b.interrupted)).toBe(true);
        for (const fiber of [first, second, shared])
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
        yield* semaphore.withPermits(2)(Effect.void);
        expect(observed).toEqual([]);
      }),
  );

  it.effect(
    "preserves cached and pending hits, admits fitting fresh targets and names refused targets",
    () =>
      Effect.gen(function* () {
        const { executor, requests, calls } = yield* controlledBackend();
        let admitted = 0;
        const observed: boolean[] = [];
        const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
          admit: (_kind, targets) => {
            expect(targets).toBe(1);
            if (admitted === 3) return false;
            admitted++;
            return true;
          },
          run: (effect) => effect,
          observeSearch: (ok) => {
            observed.push(ok);
          },
        });
        const cached = yield* start(handler({ queries: ["cached"] }));
        yield* Deferred.succeed((yield* Queue.take(requests)).reply, [
          hit("https://cached.example"),
        ]);
        yield* Fiber.join(cached);
        const pending = yield* start(handler({ queries: ["pending"] }));
        const pendingRequest = yield* Queue.take(requests);
        const mixed = yield* start(handler({ queries: ["cached", "pending", "fresh", "refused"] }));
        const fresh = yield* Queue.take(requests);
        expect(fresh.request.query).toBe("fresh");
        yield* Deferred.succeed(pendingRequest.reply, [hit("https://pending.example")]);
        yield* Deferred.succeed(fresh.reply, [hit("https://fresh.example")]);
        yield* Fiber.join(pending);
        const result = yield* Fiber.join(mixed);
        expect(result.ok).toBe(true);
        expect(result.results.map((item) => item.url)).toEqual([
          "https://cached.example/",
          "https://pending.example/",
          "https://fresh.example/",
        ]);
        expect(result.failures).toEqual([
          { target: "refused", error: "Research web budget or exploration deadline reached." },
        ]);
        expect(admitted).toBe(3);
        expect(calls).toHaveLength(3);
        expect(observed).toEqual([true, true, true]);
        expect((yield* handler({ queries: ["cached"] })).ok).toBe(true);
      }),
  );

  it.effect(
    "defers admission until a permit is held, so cancelled queued work spends nothing",
    () =>
      Effect.gen(function* () {
        const { executor, requests, calls } = yield* controlledBackend();
        const semaphore = yield* Semaphore.make(1);
        let admitted = 0;
        const observed: boolean[] = [];
        const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]), {
          admit: () => {
            admitted++;
            return true;
          },
          run: (effect) => semaphore.withPermits(1)(effect),
          observeSearch: (ok) => {
            observed.push(ok);
          },
        });
        const first = yield* start(handler({ queries: ["first"] }));
        const request = yield* Queue.take(requests);
        const queued = yield* start(handler({ queries: ["queued"] }));
        yield* settleWaiters;
        expect(admitted).toBe(1);
        yield* Fiber.interrupt(queued);
        yield* Fiber.interrupt(first);
        expect(yield* Deferred.isDone(request.interrupted)).toBe(true);
        expect(calls).toHaveLength(1);
        expect(observed).toEqual([]);
        const retry = yield* start(handler({ queries: ["queued"] }));
        yield* Deferred.succeed((yield* Queue.take(requests)).reply, []);
        expect((yield* Fiber.join(retry)).ok).toBe(true);
        expect(admitted).toBe(2);
        expect(observed).toEqual([true]);
      }),
  );

  it.effect("keeps concurrent query, time-range, language and handler keys independent", () =>
    Effect.gen(function* () {
      const { executor, requests, calls } = yield* controlledBackend();
      const handler = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]));
      const other = yield* executor.handler(createSourceIndexer([]), createUrlAuthority([]));
      const fibers = yield* Effect.forEach(
        [
          handler({ queries: ["same"] }),
          handler({ queries: ["other"] }),
          handler({ queries: ["same"], timeRange: "month" }),
          handler({ queries: ["same"], language: "de" }),
          other({ queries: ["same"] }),
        ],
        start,
      );
      for (let i = 0; i < 5; i++) yield* Deferred.succeed((yield* Queue.take(requests)).reply, []);
      yield* Effect.forEach(fibers, Fiber.join);
      expect(calls).toHaveLength(5);
      yield* handler({ queries: ["same"], timeRange: "month" });
      yield* handler({ queries: ["same"], language: "de" });
      expect(calls).toHaveLength(5);
    }),
  );
});

describe("research shared external-operation gate", () => {
  it.live(
    "limits actual requests across concurrent batched handlers instead of multiplying concurrency",
    () => {
      let active = 0;
      let peak = 0;
      let calls = 0;
      const counted = Layer.succeed(
        SearchBackend,
        SearchBackend.of({
          kind: "fake",
          test: () => Effect.succeed({ resultCount: 0 }),
          search: () =>
            Effect.gen(function* () {
              active++;
              calls++;
              peak = Math.max(peak, active);
              yield* Effect.sleep("10 millis");
              active--;
              return [hit("https://shared.example")];
            }),
        }),
      );
      const layer = WebSearchExecutor.layer.pipe(Layer.provide(Layer.mergeAll(FakeRepo, counted)));
      return Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(3);
        const executor = yield* WebSearchExecutor;
        const indexer = createSourceIndexer([]);
        const authority = createUrlAuthority([]);
        let admitted = 0;
        const handler = yield* executor.handler(indexer, authority, {
          admit: (_kind, count) => {
            if (admitted + count > 24) return false;
            admitted += count;
            return true;
          },
          run: (effect) => semaphore.withPermits(1)(effect),
        });
        const result = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          (index) => handler({ queries: [`${index}-a`, `${index}-b`, `${index}-c`] }),
          { concurrency: "unbounded" },
        );
        expect(calls).toBe(24);
        expect(peak).toBe(3);
        expect(result.filter((value) => !value.ok)).toHaveLength(2);
        expect(
          new Set(result.flatMap((value) => value.sources?.map((source) => source.index) ?? [])),
        ).toEqual(new Set([1]));
      }).pipe(Effect.provide(layer));
    },
  );
});
