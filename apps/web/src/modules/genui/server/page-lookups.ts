// Places and routes a finished answer's map computes from its state, asked
// for by the page: a pin drawn by {#each} over the block's data, a route over
// the stops the reader kept. The streaming resolver only sees literals, so
// without this an editable itinerary would draw nothing.

import { Effect } from "effect";
import {
  lookupOf,
  type UiLookups,
  type UiPlace,
  type UiRoute,
} from "~/modules/chat/assistant-output.ts";
import {
  IMAGE_QUERY_LIMITS,
  MAP_LOOKUP_LIMITS,
  normalizeQuery,
  PAGE_LOOKUP_LIMITS,
  quotedStrings,
  routeKey,
  type RouteRequest,
} from "../extract.ts";
import type { PlaceCandidate, RoutedMode } from "./map-lookups.ts";
import { pickPlace } from "./map-resolver.ts";

export interface PageLookupDeps {
  /** Maps are off: each request is recorded as such and no service is asked. */
  readonly off: boolean;
  /** The block's stored source, which every requested name must appear in. */
  readonly code: string;
  /** What the answer already holds; those keys are never asked again. */
  readonly existing: UiLookups;
  readonly geocode: (query: string) => Effect.Effect<ReadonlyArray<PlaceCandidate>>;
  readonly route: (
    mode: RoutedMode,
    stops: ReadonlyArray<{ readonly lat: number; readonly lng: number }>,
  ) => Effect.Effect<UiRoute>;
}

export interface PageLookupRequest {
  readonly places: ReadonlyArray<string>;
  readonly routes: ReadonlyArray<RouteRequest>;
}

const UNAVAILABLE = { status: "unavailable" } as const;
const MAPS_OFF = { status: "maps_off" } as const;

const resolvedAt = (place: UiPlace | undefined) =>
  place?.status === "resolved" && place.lat !== undefined && place.lng !== undefined
    ? { lat: place.lat, lng: place.lng }
    : undefined;

/** The new places and routes, never overwriting a key the answer has. */
export const resolvePageLookups = (
  deps: PageLookupDeps,
  request: PageLookupRequest,
): Effect.Effect<{ places: Record<string, UiPlace>; routes: Record<string, UiRoute> }> =>
  Effect.gen(function* () {
    const written = quotedStrings(deps.code);
    const placeRoom = Math.max(
      0,
      MAP_LOOKUP_LIMITS.placesPerAnswer +
        PAGE_LOOKUP_LIMITS.placesPerAnswer -
        Object.keys(deps.existing.places).length,
    );
    const asked = [
      ...new Set(
        request.places
          .map(normalizeQuery)
          .filter(
            (query) =>
              query !== "" &&
              query.length <= IMAGE_QUERY_LIMITS.queryChars &&
              written.has(query) &&
              !lookupOf(deps.existing.places, query),
          ),
      ),
    ].slice(0, placeRoom);

    const places: Record<string, UiPlace> = {};
    if (deps.off) {
      for (const query of asked) places[query] = MAPS_OFF;
    } else if (asked.length > 0) {
      const matches = yield* Effect.forEach(asked, deps.geocode, { concurrency: 2 });
      // The block's places the answer already placed anchor the choice, as
      // streaming did: "Munich" beside Innsbruck is not the one in North Dakota.
      const anchors = [...written].flatMap((name) => {
        const at = resolvedAt(lookupOf(deps.existing.places, name));
        return at ? [[at]] : [];
      });
      asked.forEach((query, i) => {
        const others = [...anchors, ...matches.filter((_, j) => j !== i)];
        const pick = pickPlace(matches[i]!, others);
        places[query] = pick ? { status: "resolved", ...pick } : UNAVAILABLE;
      });
    }

    const placeOf = (name: string) =>
      lookupOf(places, name) ?? lookupOf(deps.existing.places, name);
    const routeRoom = Math.max(
      0,
      MAP_LOOKUP_LIMITS.routesPerAnswer +
        PAGE_LOOKUP_LIMITS.routesPerAnswer -
        Object.keys(deps.existing.routes).length,
    );
    const wanted = new Map<string, RouteRequest>();
    for (const route of request.routes) {
      if (route.mode === "straight") continue;
      if (route.stops.length < 2 || route.stops.length > MAP_LOOKUP_LIMITS.stopsPerRoute) continue;
      const key = routeKey(route);
      if (lookupOf(deps.existing.routes, key) || wanted.has(key)) continue;
      if (wanted.size >= routeRoom) break;
      wanted.set(key, route);
    }

    const routes: Record<string, UiRoute> = {};
    for (const [key, route] of wanted) {
      if (deps.off) {
        routes[key] = MAPS_OFF;
        continue;
      }
      // A name stop must be a place this answer holds: the page never makes
      // the server geocode a stop it did not also pass the source check above.
      const stops = route.stops.map(
        (stop): UiPlace | undefined =>
          typeof stop === "string"
            ? placeOf(normalizeQuery(stop))
            : { status: "resolved", lat: stop.lat, lng: stop.lng },
      );
      if (stops.some((stop) => stop === undefined)) continue;
      const coordinates = stops.flatMap((stop) => {
        const at = resolvedAt(stop);
        return at ? [at] : [];
      });
      routes[key] =
        coordinates.length === stops.length
          ? yield* deps.route(route.mode as RoutedMode, coordinates)
          : UNAVAILABLE;
    }
    return { places, routes };
  });
