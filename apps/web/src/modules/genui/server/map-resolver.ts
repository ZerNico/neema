// Resolves the places and routes a streaming answer's maps name, like the
// image resolver does for pictures: each block is read once, when its fence
// closes, and every result is recorded as it arrives. A route waits for its
// stops' places; a straight line needs no service, the page draws it.

import { Deferred, Duration, Effect, FiberSet, type Scope } from "effect";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import { blockMapLookups, MAP_LOOKUP_LIMITS, routeKey, type RouteRequest } from "../extract.ts";
import { scanUiFences } from "../fences.ts";
import type { RoutedMode } from "./map-lookups.ts";

/** Routing services are spaced at a second a request, so the answer waits a little longer than for images. */
export const MAP_DRAIN = Duration.seconds(8);

export interface MapResolverDeps {
  /** Maps are off: every place and route is recorded as such, and no service is asked. */
  readonly off?: boolean;
  /** Places and routes an earlier attempt of this answer already settled. */
  readonly settled: { readonly places: ReadonlySet<string>; readonly routes: ReadonlySet<string> };
  /** Coordinates of places an earlier attempt resolved, which this attempt's routes may use. */
  readonly known: ReadonlyMap<string, UiPlace>;
  readonly geocode: (query: string) => Effect.Effect<UiPlace>;
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
  readonly drain: Effect.Effect<void>;
}

const UNAVAILABLE = { status: "unavailable" } as const;
const MAPS_OFF = { status: "maps_off" } as const;

export const makeMapResolver = (
  deps: MapResolverDeps,
): Effect.Effect<MapResolver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const running = yield* FiberSet.make();
    const places = new Map<string, Deferred.Deferred<UiPlace>>();
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

    /** The place's result, started on first ask; settled ones are answered at once. */
    const placeFor = (query: string) =>
      Effect.gen(function* () {
        const existing = places.get(query);
        if (existing) return existing;
        const deferred = yield* Deferred.make<UiPlace>();
        places.set(query, deferred);
        const known = deps.known.get(query);
        if (known) {
          yield* Deferred.succeed(deferred, known);
          return deferred;
        }
        if (deps.off) {
          yield* recordPlace(query, MAPS_OFF);
          yield* Deferred.succeed(deferred, MAPS_OFF);
          return deferred;
        }
        if (deps.settled.places.has(query) || places.size > MAP_LOOKUP_LIMITS.placesPerAnswer) {
          yield* Deferred.succeed(deferred, UNAVAILABLE);
          return deferred;
        }
        yield* FiberSet.run(
          running,
          deps.geocode(query).pipe(
            Effect.tap((place) => recordPlace(query, place)),
            Effect.flatMap((place) => Deferred.succeed(deferred, place)),
          ),
        );
        return deferred;
      });

    const resolveRoute = (request: RouteRequest, key: string) =>
      Effect.gen(function* () {
        if (request.mode === "straight") return;
        if (deps.off) return yield* recordRoute(key, MAPS_OFF);
        const stops = yield* Effect.forEach(request.stops, (stop) =>
          typeof stop === "string"
            ? placeFor(stop).pipe(Effect.flatMap(Deferred.await))
            : Effect.succeed<UiPlace>({ status: "resolved", ...stop }),
        );
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
      yield* FiberSet.clear(running);
      for (const query of places.keys())
        if (!deps.settled.places.has(query) && !deps.known.has(query))
          yield* recordPlace(query, UNAVAILABLE);
      for (const key of routes)
        if (!deps.settled.routes.has(key) && !key.startsWith("straight:"))
          yield* recordRoute(key, UNAVAILABLE);
    });

    return { observe, drain };
  });
