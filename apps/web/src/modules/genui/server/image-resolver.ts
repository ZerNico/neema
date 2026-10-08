// Resolves the image queries a streaming answer's ```ui blocks name. Each
// block is read once, when its fence closes; its literal queries are searched,
// a few images fetched and stored, and the outcome recorded per query. All of
// it runs in the generation's scope, so Stop or a lost lease ends it with the
// answer, and the answer waits a moment for what is still in flight.

import { Duration, Effect, FiberSet, Semaphore, type Scope } from "effect";
import type { UiImage, UiImageResult } from "~/modules/chat/assistant-output.ts";
import type { ImageHit } from "~/modules/tools/server/search-providers/types.ts";
import { blockImageQueries, IMAGE_QUERY_LIMITS } from "../extract.ts";
import { scanUiFences } from "../fences.ts";
import type { FetchedImage } from "./image-fetcher.ts";

export const IMAGE_RESOLVE_LIMITS = {
  imagesPerQuery: 4,
  /** Hits asked for, so a few that fail to fetch still leave enough. */
  candidatesPerQuery: 8,
  concurrency: 3,
  drain: Duration.seconds(5),
} as const;

export interface ImageResolverDeps {
  /** The attempt was offered web search; without it every query records `search_off`. */
  readonly searchOn: boolean;
  /** Queries an earlier attempt of this answer already settled. */
  readonly settled: ReadonlySet<string>;
  readonly search: (
    query: string,
    maxResults: number,
  ) => Effect.Effect<ReadonlyArray<ImageHit>, unknown>;
  readonly fetch: (url: string) => Effect.Effect<FetchedImage, unknown>;
  /** Stores one image for the answer; fails when the answer holds all it may. */
  readonly store: (
    image: FetchedImage,
    fileName: string,
  ) => Effect.Effect<{ readonly id: string }, unknown>;
  /** Persists and announces one query's outcome. */
  readonly record: (query: string, result: UiImageResult) => Effect.Effect<void>;
}

export interface ImageResolver {
  /** Reads the answer so far and starts work for any block that has closed since. */
  readonly observe: (text: string) => Effect.Effect<void>;
  /** Waits briefly for work in flight, then records what is left as unavailable. */
  readonly drain: Effect.Effect<void>;
}

const extensionOf = (mediaType: string) => mediaType.split("/")[1] ?? "img";

export const makeImageResolver = (
  deps: ImageResolverDeps,
): Effect.Effect<ImageResolver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const running = yield* FiberSet.make();
    const permits = yield* Semaphore.make(IMAGE_RESOLVE_LIMITS.concurrency);
    // Every query this answer has named, settled earlier or started here; the cap counts them all.
    const named = new Set(deps.settled);
    const recorded = new Set<string>();
    let blocksRead = 0;
    let storedCount = 0;

    const record = (query: string, result: UiImageResult) =>
      Effect.suspend(() => {
        if (recorded.has(query)) return Effect.void;
        recorded.add(query);
        return deps.record(query, result);
      });

    const fetchHit = (hit: ImageHit) =>
      // The thumbnail is smaller and usually enough for a tile; the original is the fallback.
      (hit.thumbnailUrl
        ? deps.fetch(hit.thumbnailUrl).pipe(Effect.catch(() => deps.fetch(hit.imageUrl)))
        : deps.fetch(hit.imageUrl)
      ).pipe(Effect.option);

    const resolve = (query: string) =>
      Effect.gen(function* () {
        if (!deps.searchOn) return yield* record(query, { status: "search_off", items: [] });
        const hits = yield* deps.search(query, IMAGE_RESOLVE_LIMITS.candidatesPerQuery);
        const items: UiImage[] = [];
        let next = 0;
        let full = false;
        // Fetch only as many as are still missing, so a good first page costs four fetches.
        while (!full && items.length < IMAGE_RESOLVE_LIMITS.imagesPerQuery && next < hits.length) {
          const batch = hits.slice(next, next + IMAGE_RESOLVE_LIMITS.imagesPerQuery - items.length);
          next += batch.length;
          const fetched = yield* Effect.forEach(
            batch,
            (hit) => fetchHit(hit).pipe(Effect.map((image) => ({ hit, image }))),
            { concurrency: 2 },
          );
          for (const { hit, image } of fetched) {
            if (image._tag === "None") continue;
            const stored = yield* deps
              .store(image.value, `image-${++storedCount}.${extensionOf(image.value.mediaType)}`)
              .pipe(Effect.option);
            // The answer holds all the images it may; the rest would be refused too.
            if (stored._tag === "None") {
              full = true;
              break;
            }
            items.push({
              attachmentId: stored.value.id,
              pageUrl: hit.pageUrl,
              title: hit.title,
              width: image.value.size.width,
              height: image.value.size.height,
            });
          }
        }
        yield* record(query, { status: items.length ? "resolved" : "unavailable", items });
      }).pipe(
        Effect.catch(() => record(query, { status: "unavailable", items: [] })),
        permits.withPermits(1),
      );

    const observe = (text: string) =>
      Effect.gen(function* () {
        const fences = scanUiFences(text);
        for (const fence of fences.slice(blocksRead)) {
          if (!fence.closed) break;
          blocksRead++;
          for (const query of blockImageQueries(fence.code)) {
            if (named.has(query) || named.size >= IMAGE_QUERY_LIMITS.queriesPerAnswer) continue;
            named.add(query);
            yield* FiberSet.run(running, resolve(query));
          }
        }
      });

    const drain = Effect.gen(function* () {
      yield* FiberSet.awaitEmpty(running).pipe(Effect.timeoutOption(IMAGE_RESOLVE_LIMITS.drain));
      yield* FiberSet.clear(running);
      for (const query of named) {
        if (!deps.settled.has(query)) yield* record(query, { status: "unavailable", items: [] });
      }
    });

    return { observe, drain };
  });
