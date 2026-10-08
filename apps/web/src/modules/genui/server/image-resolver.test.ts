import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { UiImageResult } from "~/modules/chat/assistant-output.ts";
import type { ImageHit } from "~/modules/tools/server/search-providers/types.ts";
import { makeImageResolver, type ImageResolverDeps } from "./image-resolver.ts";

const block = (...queries: string[]) =>
  "```ui\n" + queries.map((q) => `<image query="${q}"/>`).join("\n") + "\n```\n";

const hit = (n: number): ImageHit => ({
  imageUrl: `https://img.example/${n}.png`,
  thumbnailUrl: `https://thumb.example/${n}.png`,
  pageUrl: `https://page.example/${n}`,
  title: `Image ${n}`,
});

const image = { bytes: new Uint8Array([1]), mediaType: "image/png", size: { width: 4, height: 3 } };

const harness = (overrides: Partial<ImageResolverDeps> = {}) => {
  const searched: string[] = [];
  const fetched: string[] = [];
  const recorded = new Map<string, UiImageResult>();
  let stored = 0;
  const deps: ImageResolverDeps = {
    searchOn: true,
    settled: new Set(),
    search: (query) =>
      Effect.sync(() => {
        searched.push(query);
        return [1, 2, 3, 4, 5, 6].map(hit);
      }),
    fetch: (url) =>
      Effect.suspend(() => {
        fetched.push(url);
        // Thumbnails of image 2 fail; its original works. Image 3 fails both ways.
        if (url.includes("/2.") && url.includes("thumb")) return Effect.fail("thumb down");
        if (url.includes("/3.")) return Effect.fail("gone");
        return Effect.succeed(image);
      }),
    store: () => Effect.sync(() => ({ id: `att-${++stored}` })),
    record: (query, result) => Effect.sync(() => void recorded.set(query, result)),
    ...overrides,
  };
  return { deps, searched, fetched, recorded };
};

describe("image resolver", () => {
  it.effect("resolves each closed block once, up to four images per query", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeImageResolver(h.deps);
      // Still open: nothing yet.
      yield* resolver.observe('Hi\n```ui\n<image query="gear hub"/>');
      expect(h.searched).toEqual([]);
      const text = "Hi\n" + block("gear hub", " gear   hub ", "cassette");
      yield* resolver.observe(text);
      yield* resolver.observe(text + "more");
      yield* resolver.drain;
      expect(h.searched).toEqual(["gear hub", "cassette"]);
      const result = h.recorded.get("gear hub")!;
      expect(result.status).toBe("resolved");
      expect(result.items.map((item) => item.pageUrl)).toEqual([
        "https://page.example/1",
        "https://page.example/2",
        "https://page.example/4",
        "https://page.example/5",
      ]);
      expect(result.items[0]).toMatchObject({ width: 4, height: 3, title: "Image 1" });
      expect(h.fetched).toContain("https://img.example/2.png");
      // Four were enough by the fifth candidate; the sixth was never fetched.
      expect(h.fetched.some((url) => url.includes("/6."))).toBe(false);
    }),
  );

  it.effect("records search_off without searching when the attempt had no web search", () =>
    Effect.gen(function* () {
      const h = harness({ searchOn: false });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("a"));
      yield* resolver.drain;
      expect(h.searched).toEqual([]);
      expect(h.recorded.get("a")).toEqual({ status: "search_off", items: [] });
    }),
  );

  it.effect("records unavailable when search fails or storage is full", () =>
    Effect.gen(function* () {
      const h = harness({
        search: (query) => (query === "bad" ? Effect.fail("down") : Effect.succeed([hit(1)])),
        store: () => Effect.fail("full"),
      });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("bad", "full"));
      yield* resolver.drain;
      expect(h.recorded.get("bad")).toEqual({ status: "unavailable", items: [] });
      expect(h.recorded.get("full")).toEqual({ status: "unavailable", items: [] });
    }),
  );

  it.effect("skips what an earlier attempt settled and keeps the answer's cap across both", () =>
    Effect.gen(function* () {
      const settled = new Set(["q0", "q1", "q2", "q3", "q4", "q5", "q6"]);
      const h = harness({ settled });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("q0", "q7", "q8"));
      yield* resolver.drain;
      expect(h.searched).toEqual(["q7"]);
      expect([...h.recorded.keys()]).toEqual(["q7"]);
    }),
  );

  it.effect("keeps the images it stored when the drain limit cuts a later batch short", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<typeof image>();
      const h = harness({
        // The first batch stores image 1 only; the second hangs on image 5.
        fetch: (url) =>
          url.includes("/1.")
            ? Effect.succeed(image)
            : url.includes("/5.")
              ? Deferred.await(never)
              : Effect.fail("gone"),
      });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("partly"));
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(draining);
      expect(h.recorded.get("partly")).toMatchObject({
        status: "resolved",
        items: [{ attachmentId: "att-1", pageUrl: "https://page.example/1" }],
      });
    }),
  );

  it.effect("records again a result whose write the drain limit interrupted", () =>
    Effect.gen(function* () {
      const stuck = yield* Deferred.make<void>();
      const recorded = new Map<string, UiImageResult>();
      let attempts = 0;
      const h = harness({
        // The first write waits on a busy database past the deadline; the next goes through.
        record: (query, result) =>
          ++attempts === 1
            ? Deferred.await(stuck)
            : Effect.sync(() => void recorded.set(query, result)),
      });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("busy"));
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(draining);
      expect(recorded.get("busy")).toMatchObject({ status: "resolved" });
    }),
  );

  it.effect("stops waiting after the drain limit and records the rest as unavailable", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<ReadonlyArray<ImageHit>>();
      const h = harness({ search: () => Deferred.await(never) });
      const resolver = yield* makeImageResolver(h.deps);
      yield* resolver.observe(block("slow"));
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(draining);
      expect(h.recorded.get("slow")).toEqual({ status: "unavailable", items: [] });
    }),
  );
});
