// `map_route`: real distances and times for a route, in any chat. Without it
// a model guesses ("about 250 km") beside a map that says 225. Inside an
// answer its results are also the answer's map lookups, so a ```ui map of
// the same stops draws at once and with the numbers the prose quotes.

import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import { advertisedParameter, type ToolGroup } from "~/modules/tools/server/toolset.ts";
import {
  IMAGE_QUERY_LIMITS,
  MAP_LOOKUP_LIMITS,
  normalizeQuery,
  routeKey,
  type RouteStop,
} from "../extract.ts";
import {
  MAP_ROUTE_MODES,
  MAP_ROUTE_TOOL,
  MapRouteResult,
  type MapRouteStop,
} from "../map-tool-schema.ts";
import type { PlaceCandidate, RoutedMode } from "./map-lookups.ts";
import { pickPlace } from "./map-resolver.ts";

/** Calls per answer: each one is a geocoder request per stop and a routing request. */
export const MAP_ROUTE_CALLS = 8;

// Validated in the handler, like notify_user: a malformed call comes back as a
// correction instead of failing the stream.
const Params = Schema.Struct({
  stops: advertisedParameter({
    type: "array",
    items: { type: "string", maxLength: IMAGE_QUERY_LIMITS.queryChars },
    minItems: 2,
    maxItems: MAP_LOOKUP_LIMITS.stopsPerRoute,
  }),
  mode: advertisedParameter({ type: "string", enum: [...MAP_ROUTE_MODES] }),
});

export const mapRouteTool = Tool.make(MAP_ROUTE_TOOL, {
  description:
    "Real distance and travel time of a route by road, on foot or by bike, from OpenStreetMap: " +
    "the whole route and each leg between consecutive stops. Call it before you state how far " +
    "or how long a trip is, rather than estimating. " +
    `stops: 2 to ${MAP_LOOKUP_LIMITS.stopsPerRoute} places in visiting order, each a name on a map plus its town ` +
    '("Museum Barberini, Potsdam") or "lat,lng". mode: drive (default), walk or bike. ' +
    "When an interactive map shows the same route, give its <route> exactly these stops and mode.",
  parameters: Params,
  success: MapRouteResult,
  failureMode: "return",
});

export interface MapRouteDeps {
  readonly geocode: (query: string) => Effect.Effect<ReadonlyArray<PlaceCandidate>>;
  readonly route: (
    mode: RoutedMode,
    stops: ReadonlyArray<{ readonly lat: number; readonly lng: number }>,
  ) => Effect.Effect<UiRoute>;
  /** Hands what was found to the answer's map lookups; absent outside an answer's generation. */
  readonly seed?: (update: {
    readonly places: Readonly<Record<string, UiPlace>>;
    readonly routes: Readonly<Record<string, UiRoute>>;
  }) => Effect.Effect<void>;
}

const COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** A stop as written: "lat,lng" in range, or a name; null when it is neither. */
function readStop(value: unknown): RouteStop | null {
  if (typeof value !== "string") return null;
  const match = COORDINATES.exec(value);
  if (match) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }
  const name = normalizeQuery(value);
  return name !== "" && name.length <= IMAGE_QUERY_LIMITS.queryChars ? name : null;
}

const rejected = (message: string, stops?: MapRouteStop[]): MapRouteResult => ({
  v: 1,
  outcome: "rejected",
  message,
  ...(stops ? { stops } : {}),
});

export function prepareMapRouteTool(deps: MapRouteDeps): ToolGroup {
  let calls = 0;
  const handler = (params: { readonly stops?: unknown; readonly mode?: unknown }) =>
    Effect.gen(function* (): Effect.fn.Return<MapRouteResult> {
      const mode = params.mode === undefined ? "drive" : params.mode;
      const routed = MAP_ROUTE_MODES.find((known) => known === mode);
      if (!routed) return rejected("mode is drive, walk or bike.");
      const raw: unknown[] = Array.isArray(params.stops) ? params.stops : [];
      const written = raw.map(readStop).filter((stop): stop is RouteStop => stop !== null);
      if (
        written.length !== raw.length ||
        written.length < 2 ||
        written.length > MAP_LOOKUP_LIMITS.stopsPerRoute
      )
        return rejected(
          `stops is 2 to ${MAP_LOOKUP_LIMITS.stopsPerRoute} places in order, each a name with its town or "lat,lng".`,
        );
      if (++calls > MAP_ROUTE_CALLS)
        return rejected(`This answer already looked up ${MAP_ROUTE_CALLS} routes.`);

      const names = [...new Set(written.filter((stop) => typeof stop === "string"))];
      const matches = new Map(
        yield* Effect.forEach(
          names,
          (name) => deps.geocode(name).pipe(Effect.map((found) => [name, found] as const)),
          { concurrency: 2 },
        ),
      );
      // Each name chosen by the others, as a map's places are: "Munich" between
      // Innsbruck and Salzburg is not the one in North Dakota.
      const places = new Map<string, PlaceCandidate | undefined>();
      for (const name of names) {
        const others = written.flatMap((stop) =>
          stop === name ? [] : [typeof stop === "string" ? (matches.get(stop) ?? []) : [stop]],
        );
        places.set(name, pickPlace(matches.get(name) ?? [], others));
      }
      const found = written.map((stop): MapRouteStop => {
        if (typeof stop !== "string")
          return { query: `${stop.lat},${stop.lng}`, found: true, ...stop };
        const place = places.get(stop);
        return place ? { query: stop, found: true, ...place } : { query: stop, found: false };
      });
      const missing = found.filter((stop) => !stop.found).map((stop) => stop.query);
      if (missing.length > 0)
        return rejected(
          `Couldn’t find ${missing.join(", ")}. Name each place as on a map with its town, or give "lat,lng".`,
          found,
        );

      const route = yield* deps.route(
        routed,
        found.map((stop) => ({ lat: stop.lat!, lng: stop.lng! })),
      );
      if (deps.seed) {
        const seeded: Record<string, UiPlace> = {};
        for (const [name, place] of places)
          if (place) seeded[name] = { status: "resolved", ...place };
        yield* deps.seed({
          places: seeded,
          routes: { [routeKey({ mode: routed, stops: written })]: route },
        });
      }
      if (
        route.status !== "resolved" ||
        route.distance === undefined ||
        route.duration === undefined
      )
        return rejected(`No ${routed} route was found between these stops.`, found);
      return {
        v: 1,
        outcome: "routed",
        mode: routed,
        stops: found,
        distance: route.distance,
        duration: route.duration,
        ...(route.legs ? { legs: route.legs } : {}),
      };
    });
  return {
    family: "map",
    toolkit: Toolkit.make(mapRouteTool),
    handlers: { [MAP_ROUTE_TOOL]: handler },
  };
}
