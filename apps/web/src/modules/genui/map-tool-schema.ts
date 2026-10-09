import { Schema } from "effect";

export const MAP_ROUTE_TOOL = "map_route";
export const MAP_ROUTE_MODES = ["drive", "walk", "bike"] as const;

/** One stop as the tool found it: where a name is, or that it is nowhere. */
export const MapRouteStop = Schema.Struct({
  query: Schema.String,
  found: Schema.Boolean,
  name: Schema.optionalKey(Schema.String),
  lat: Schema.optionalKey(Schema.Finite),
  lng: Schema.optionalKey(Schema.Finite),
});
export type MapRouteStop = typeof MapRouteStop.Type;

const Stretch = Schema.Struct({ distance: Schema.Finite, duration: Schema.Finite });

/**
 * What a `map_route` call found: the stops, the whole route and each leg, in
 * metres and seconds. No geometry; that is drawn by a map, never read.
 */
export const MapRouteResult = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["routed"]),
    mode: Schema.Literals(MAP_ROUTE_MODES),
    stops: Schema.Array(MapRouteStop),
    distance: Schema.Finite,
    duration: Schema.Finite,
    legs: Schema.optionalKey(Schema.Array(Stretch)),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    outcome: Schema.Literals(["rejected"]),
    message: Schema.String,
    stops: Schema.optionalKey(Schema.Array(MapRouteStop)),
  }),
]);
export type MapRouteResult = typeof MapRouteResult.Type;

/** What a call's activity row shows: the stops as written and the totals. */
export const MapRouteSummary = Schema.Struct({
  mode: Schema.Literals(MAP_ROUTE_MODES),
  stops: Schema.Array(Schema.String),
  distance: Schema.Finite,
  duration: Schema.Finite,
});
export type MapRouteSummary = typeof MapRouteSummary.Type;

/** The row's summary of a stored or streamed result; null for a refusal. */
export const summarizeMapRoute = (result: MapRouteResult): MapRouteSummary | null =>
  result.outcome === "routed"
    ? {
        mode: result.mode,
        stops: result.stops.map((stop) => stop.query),
        distance: result.distance,
        duration: result.duration,
      }
    : null;
