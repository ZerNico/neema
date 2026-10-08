// Turning a map's place names into coordinates, and its stops into roads.
// Both go to public OpenStreetMap services by default (Photon for places,
// FOSSGIS's OSRM for routes), which ask for light, identified use: requests
// to one host are spaced out and carry a User-Agent.

import { Context, Duration, Effect, Layer, Schema, Semaphore } from "effect";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import type { MapServices } from "../settings.ts";

const USER_AGENT = "neema/1.0 (self-hosted chat; maps in answers)";
const TIMEOUT = Duration.seconds(8);
/** A route is drawn, not navigated: past this many points the shape gains nothing. */
const MAX_PATH_POINTS = 1000;

/** Minimum spacing between requests to one host. FOSSGIS asks for one a second. */
const spacingFor = (host: string) => (host === "routing.openstreetmap.de" ? 1000 : 200);

const PhotonResponse = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      geometry: Schema.Struct({ coordinates: Schema.Tuple([Schema.Finite, Schema.Finite]) }),
      properties: Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        city: Schema.optionalKey(Schema.String),
        country: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
});
const decodePhoton = Schema.decodeUnknownEffect(PhotonResponse);

const OsrmResponse = Schema.Struct({
  code: Schema.String,
  routes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        distance: Schema.Finite,
        duration: Schema.Finite,
        geometry: Schema.Struct({
          coordinates: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
        }),
      }),
    ),
  ),
});
const decodeOsrm = Schema.decodeUnknownEffect(OsrmResponse);

export type RoutedMode = "drive" | "walk" | "bike";
const PROFILE: Record<RoutedMode, string> = {
  drive: "routed-car",
  walk: "routed-foot",
  bike: "routed-bike",
};

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/** Evenly thinned, always keeping the first and last point. */
export function thinPath(
  points: ReadonlyArray<readonly [number, number]>,
  max = MAX_PATH_POINTS,
): Array<readonly [number, number]> {
  const kept =
    points.length <= max
      ? points
      : Array.from(
          { length: max },
          (_, i) => points[Math.round((i * (points.length - 1)) / (max - 1))]!,
        );
  return kept.map(([lng, lat]) => [round(lng), round(lat)] as const);
}

const UNAVAILABLE = { status: "unavailable" } as const;

export class MapLookups extends Context.Service<
  MapLookups,
  {
    /** Never fails: a miss or an outage is an `unavailable` place. */
    geocode(services: MapServices, query: string): Effect.Effect<UiPlace>;
    route(
      services: MapServices,
      mode: RoutedMode,
      stops: ReadonlyArray<{ readonly lat: number; readonly lng: number }>,
    ): Effect.Effect<UiRoute>;
  }
>()("genui/MapLookups") {
  static readonly layer = Layer.effect(
    MapLookups,
    Effect.sync(() => {
      // One queue per host, so spacing for one service never slows another.
      const queues = new Map<string, { gate: Semaphore.Semaphore; next: number }>();
      const spaced = <A, E>(url: URL, request: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          let queue = queues.get(url.host);
          if (!queue) {
            queue = { gate: yield* Semaphore.make(1), next: 0 };
            queues.set(url.host, queue);
          }
          const { gate } = queue;
          const entry = queue;
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const wait = entry.next - Date.now();
              if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
              entry.next = Date.now() + spacingFor(url.host);
              return yield* request;
            }),
          );
        });
      const getJson = (url: URL) =>
        spaced(
          url,
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(url, {
                signal,
                headers: { "user-agent": USER_AGENT, accept: "application/json" },
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return (await response.json()) as unknown;
            },
            catch: (error) => error,
          }).pipe(Effect.timeout(TIMEOUT)),
        );

      return MapLookups.of({
        geocode: (services, query) =>
          Effect.gen(function* () {
            const url = new URL(`${services.geocoder}/api`);
            url.searchParams.set("q", query);
            url.searchParams.set("limit", "1");
            const found = yield* decodePhoton(yield* getJson(url));
            const feature = found.features[0];
            if (!feature) return UNAVAILABLE;
            const [lng, lat] = feature.geometry.coordinates;
            const { name, city, country } = feature.properties;
            return {
              status: "resolved",
              lat: round(lat),
              lng: round(lng),
              ...(name ? { name: [name, city, country].filter(Boolean).join(", ") } : {}),
            } satisfies UiPlace;
          }).pipe(Effect.catch(() => Effect.succeed(UNAVAILABLE))),
        route: (services, mode, stops) =>
          Effect.gen(function* () {
            const coordinates = stops.map((s) => `${s.lng},${s.lat}`).join(";");
            const url = new URL(
              `${services.routing}/${PROFILE[mode]}/route/v1/driving/${coordinates}`,
            );
            url.searchParams.set("overview", "simplified");
            url.searchParams.set("geometries", "geojson");
            const answer = yield* decodeOsrm(yield* getJson(url));
            const best = answer.code === "Ok" ? answer.routes?.[0] : undefined;
            if (!best) return UNAVAILABLE;
            return {
              status: "resolved",
              path: thinPath(best.geometry.coordinates),
              distance: Math.round(best.distance),
              duration: Math.round(best.duration),
            } satisfies UiRoute;
          }).pipe(Effect.catch(() => Effect.succeed(UNAVAILABLE))),
      });
    }),
  );
}
