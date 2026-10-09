// Resolves the places and routes a streaming answer's maps name, like the
// image resolver does for pictures: each block is read once, when its fence
// closes, and every result is recorded as it arrives. A route waits for its
// stops' places; a straight line needs no service, the page draws it.

import { Deferred, Duration, Effect, FiberSet, type Scope } from "effect";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import {
  blockMapLookups,
  MAP_LOOKUP_LIMITS,
  normalizeQuery,
  routeKey,
  type RouteRequest,
} from "../extract.ts";
import { scanUiFences } from "../fences.ts";
import type { PlaceCandidate, RoutedMode } from "./map-lookups.ts";

/** Routing services are spaced at a second a request, so the answer waits a little longer than for images. */
export const MAP_DRAIN = Duration.seconds(8);
/** After the drain cut, how long routes get to use the places that did arrive. */
const ROUTE_GRACE = Duration.seconds(3);

export interface MapResolverDeps {
  /** Maps are off: every place and route is recorded as such, and no service is asked. */
  readonly off?: boolean;
  /** Places and routes an earlier attempt of this answer already settled. */
  readonly settled: { readonly places: ReadonlySet<string>; readonly routes: ReadonlySet<string> };
  /** Coordinates of places an earlier attempt resolved, which this attempt's routes may use. */
  readonly known: ReadonlyMap<string, UiPlace>;
  readonly geocode: (query: string) => Effect.Effect<ReadonlyArray<PlaceCandidate>>;
  readonly route: (
    mode: RoutedMode,
    stops: ReadonlyArray<{ readonly lat: number; readonly lng: number }>,
  ) => Effect.Effect<UiRoute>;
  readonly record: (update: {
    readonly places?: Readonly<Record<string, UiPlace>>;
    readonly routes?: Readonly<Record<string, UiRoute>>;
  }) => Effect.Effect<void>;
}

export interface MapResolver {
  readonly observe: (text: string) => Effect.Effect<void>;
  /**
   * Places and routes found elsewhere in this attempt (the route tool), taken
   * as decided: a block naming them later draws them without asking again.
   */
  readonly seed: (update: {
    readonly places?: Readonly<Record<string, UiPlace>>;
    readonly routes?: Readonly<Record<string, UiRoute>>;
  }) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

const UNAVAILABLE = { status: "unavailable" } as const;
const MAPS_OFF = { status: "maps_off" } as const;

const EARTH_KM = 6371;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
function kilometres(a: PlaceCandidate, b: PlaceCandidate) {
  const h =
    Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Slack before a match counts as far from its map: twice the nearest one's spread, plus this. */
const OUTLIER_KM = 50;
/** Nearness decides only on a regional map: past this mean distance places are just far apart. */
const REGIONAL_KM = 500;
/** The other places make a region when at least two of them lie this close together. */
const REGION_KM = 1_000;
/** Anchors closer than this are one place named twice. */
const SAME_PLACE_KM = 25;

/**
 * The geocoder's first match, unless it lies far from the map's other places
 * and a later one does not: then the first that does. Nearness only breaks
 * outliers ("Munich" in North Dakota beside Innsbruck); always taking the
 * nearest chose a district or a hamlet over the town the geocoder ranked first.
 * The region must come from the other places alone: two of them, close
 * together. "Boston" beside London alone is no region, only a namesake near it,
 * and a world tour has none, so there the ranking stands.
 */
export function pickPlace(
  own: ReadonlyArray<PlaceCandidate>,
  others: ReadonlyArray<ReadonlyArray<PlaceCandidate>>,
): PlaceCandidate | undefined {
  const context = others.filter((list) => list.length > 0);
  // One place named twice ("London", "London, United Kingdom") is one anchor,
  // or a single neighbour could pass for a region.
  const anchors = context
    .map((list) => list[0]!)
    .filter((a, i, all) => all.slice(0, i).every((b) => kilometres(a, b) > SAME_PLACE_KM));
  // Two of them close is enough; a trip may still reach far, and the mean
  // distance below keeps a world tour out.
  const regional = anchors.some((a, i) =>
    anchors.some((b, j) => i !== j && kilometres(a, b) <= REGION_KM),
  );
  if (!regional) return own[0];
  // Mean distance to the other places' anchors (decided, else ranked first),
  // never to their namesakes: London, Ontario sits beside Paris, Ontario, and
  // measured against those it would pull London and Paris across the Atlantic.
  const spread = own.map(
    (candidate) =>
      anchors.reduce((sum, anchor) => sum + kilometres(candidate, anchor), 0) / anchors.length,
  );
  const nearest = Math.min(...spread);
  if (nearest > REGIONAL_KM) return own[0];
  const limit = 2 * nearest + OUTLIER_KM;
  return own.find((_, i) => spread[i]! <= limit);
}

export const makeMapResolver = (
  deps: MapResolverDeps,
): Effect.Effect<MapResolver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const running = yield* FiberSet.make();
    const places = new Map<string, Deferred.Deferred<UiPlace>>();
    /** Places with a result, for reading without waiting. */
    const decided = new Map<string, UiPlace>();
    const candidates = new Map<string, Deferred.Deferred<ReadonlyArray<PlaceCandidate>>>();
    /** Matches that have come back, readable without waiting. */
    const arrived = new Map<string, ReadonlyArray<PlaceCandidate>>();
    /** Each read block's place names, for the drain to decide what arrived in time. */
    const blocks: Array<ReadonlyArray<string>> = [];
    /** The block that decides each place: the first to name it. */
    const owner = new Map<string, number>();
    const recordedPlaces = new Set<string>();
    const routes = new Set<string>(deps.settled.routes);
    const recordedRoutes = new Set<string>();
    let blocksRead = 0;

    // Counted as recorded once the write succeeded, so the drain retries one it interrupted.
    const recordPlace = (query: string, place: UiPlace) =>
      Effect.suspend(() =>
        recordedPlaces.has(query)
          ? Effect.void
          : deps
              .record({ places: { [query]: place } })
              .pipe(Effect.tap(() => Effect.sync(() => recordedPlaces.add(query)))),
      );
    const recordRoute = (key: string, route: UiRoute) =>
      Effect.suspend(() =>
        recordedRoutes.has(key)
          ? Effect.void
          : deps
              .record({ routes: { [key]: route } })
              .pipe(Effect.tap(() => Effect.sync(() => recordedRoutes.add(key)))),
      );

    const decide = (query: string, place: UiPlace) =>
      Effect.gen(function* () {
        decided.set(query, place);
        yield* Deferred.succeed(places.get(query)!, place);
      });

    /**
     * The place's result, created on first ask; settled ones are answered at
     * once. One to look up gets its matches fetched here and is decided by its
     * block (`settleBlock`).
     */
    const placeFor = (query: string) =>
      Effect.gen(function* () {
        const existing = places.get(query);
        if (existing) return existing;
        const deferred = yield* Deferred.make<UiPlace>();
        places.set(query, deferred);
        const known = deps.known.get(query);
        if (known) {
          yield* decide(query, known);
          return deferred;
        }
        if (deps.off) {
          yield* recordPlace(query, MAPS_OFF);
          yield* decide(query, MAPS_OFF);
          return deferred;
        }
        if (deps.settled.places.has(query) || places.size > MAP_LOOKUP_LIMITS.placesPerAnswer) {
          yield* decide(query, UNAVAILABLE);
          return deferred;
        }
        const found = yield* Deferred.make<ReadonlyArray<PlaceCandidate>>();
        candidates.set(query, found);
        yield* FiberSet.run(
          running,
          deps.geocode(query).pipe(
            Effect.tap((matches) => Effect.sync(() => arrived.set(query, matches))),
            Effect.flatMap((matches) => Deferred.succeed(found, matches)),
          ),
        );
        return deferred;
      });

    /**
     * Decides a block's undecided places once all its matches are in, each by
     * the others: the geocoder ranks a name worldwide, and "Munich" beside
     * Innsbruck is not the one in North Dakota.
     */
    /** A place's matches as context: its decided spot, or what the geocoder sent. */
    const optionsFor = (query: string): ReadonlyArray<PlaceCandidate> => {
      const done = decided.get(query);
      if (!done) return arrived.get(query) ?? [];
      return done.status === "resolved" && done.lat !== undefined && done.lng !== undefined
        ? [{ lat: done.lat, lng: done.lng }]
        : [];
    };

    /**
     * Picks the places a block owns whose matches are in, marking each decided
     * in the same step. A place belongs to the first block that names it, so a
     * later block naming it alone cannot decide it without that context.
     */
    const choose = (block: number) => {
      const unique = [...new Set(blocks[block])];
      const fresh: Array<readonly [string, UiPlace]> = [];
      for (const query of unique) {
        const own = arrived.get(query);
        if (owner.get(query) !== block || decided.has(query) || !own) continue;
        const others = unique.flatMap((other) => (other === query ? [] : [optionsFor(other)]));
        const pick = pickPlace(own, others);
        const place: UiPlace = pick ? { status: "resolved", ...pick } : UNAVAILABLE;
        decided.set(query, place);
        fresh.push([query, place]);
      }
      return fresh;
    };

    // Every place goes to the routes waiting on it before any is written, so
    // one slow write cannot keep a route from places already decided.
    const publish = (fresh: ReadonlyArray<readonly [string, UiPlace]>) =>
      Effect.gen(function* () {
        for (const [query, place] of fresh) yield* Deferred.succeed(places.get(query)!, place);
        for (const [query, place] of fresh) yield* recordPlace(query, place);
      });

    const settleBlock = (block: number) =>
      Effect.gen(function* () {
        for (const query of blocks[block]!) {
          const found = candidates.get(query);
          if (found) yield* Deferred.await(found);
        }
        yield* publish(yield* Effect.sync(() => choose(block)));
      });

    const resolveRoute = (request: RouteRequest, key: string) =>
      Effect.gen(function* () {
        if (request.mode === "straight") return;
        if (deps.off) return yield* recordRoute(key, MAPS_OFF);
        // The block's own places, by the name the extractor gave them; a stop it
        // dropped (blank, too long) has no place to wait for.
        const stops = yield* Effect.forEach(request.stops, (stop) => {
          if (typeof stop !== "string")
            return Effect.succeed<UiPlace>({ status: "resolved", ...stop });
          const place = places.get(normalizeQuery(stop));
          return place ? Deferred.await(place) : Effect.succeed<UiPlace>(UNAVAILABLE);
        });
        const coordinates = stops.flatMap((s) =>
          s.status === "resolved" && s.lat !== undefined && s.lng !== undefined
            ? [{ lat: s.lat, lng: s.lng }]
            : [],
        );
        const route =
          coordinates.length === stops.length
            ? yield* deps.route(request.mode, coordinates)
            : UNAVAILABLE;
        yield* recordRoute(key, route);
      });

    const observe = (text: string) =>
      Effect.gen(function* () {
        for (const fence of scanUiFences(text).slice(blocksRead)) {
          if (!fence.closed) break;
          blocksRead++;
          const found = blockMapLookups(fence.code);
          for (const query of found.places) yield* placeFor(query);
          const block = blocks.push(found.places) - 1;
          for (const query of found.places) if (!owner.has(query)) owner.set(query, block);
          yield* FiberSet.run(running, settleBlock(block));
          for (const request of found.routes) {
            const key = routeKey(request);
            if (routes.has(key) || routes.size >= MAP_LOOKUP_LIMITS.routesPerAnswer) continue;
            routes.add(key);
            yield* FiberSet.run(running, resolveRoute(request, key));
          }
        }
      });

    const drain = Effect.gen(function* () {
      yield* FiberSet.awaitEmpty(running).pipe(Effect.timeoutOption(MAP_DRAIN));
      // A slow lookup must not cost its block the places that did come back,
      // nor the routes between them: hand those to the routes waiting on them
      // and give the routes a moment. Written below, after the cut, so a stuck
      // write cannot hold the drain.
      for (const block of blocks.keys()) choose(block);
      // Every decision, not just these: one whose write stalled was never released.
      for (const [query, place] of decided) yield* Deferred.succeed(places.get(query)!, place);
      const routing = [...routes].some(
        (key) =>
          !recordedRoutes.has(key) && !deps.settled.routes.has(key) && !key.startsWith("straight:"),
      );
      if (routing) yield* FiberSet.awaitEmpty(running).pipe(Effect.timeoutOption(ROUTE_GRACE));
      yield* FiberSet.clear(running);
      // A decision whose write the deadline cut off is still that decision.
      for (const query of places.keys())
        if (!deps.settled.places.has(query) && !deps.known.has(query))
          yield* recordPlace(query, decided.get(query) ?? UNAVAILABLE);
      for (const key of routes)
        if (!deps.settled.routes.has(key) && !key.startsWith("straight:"))
          yield* recordRoute(key, UNAVAILABLE);
    });

    const seed: MapResolver["seed"] = (update) =>
      Effect.gen(function* () {
        // A name a block already asked for is that block's to decide.
        for (const [query, place] of Object.entries(update.places ?? {})) {
          if (places.has(query)) continue;
          const deferred = yield* Deferred.make<UiPlace>();
          places.set(query, deferred);
          yield* decide(query, place);
          yield* recordPlace(query, place);
        }
        for (const [key, route] of Object.entries(update.routes ?? {})) {
          if (routes.has(key)) continue;
          routes.add(key);
          yield* recordRoute(key, route);
        }
      });

    return { observe, seed, drain };
  });
