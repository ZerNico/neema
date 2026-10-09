import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { NO_LOOKUPS, type UiLookups, type UiRoute } from "~/modules/chat/assistant-output.ts";
import { routeKey } from "../extract.ts";
import type { PlaceCandidate } from "./map-lookups.ts";
import { resolvePageLookups, type PageLookupDeps } from "./page-lookups.ts";

const CODE = `<script>
  let stops = $state(["Innsbruck", "Munich", "Ferry Building"]);
</script>
<map label="Trip">{#each stops as s}<pin place={s}/>{/each}</map>`;

const MATCHES: Record<string, PlaceCandidate[]> = {
  // Photon ranks the namesake an ocean away first.
  Munich: [
    { lat: 48.66917, lng: -98.83263, name: "Munich, United States" },
    { lat: 48.13743, lng: 11.57549, name: "München, Deutschland" },
  ],
  "Ferry Building": [{ lat: 37.7955, lng: -122.3935 }],
};

const ROAD: UiRoute = { status: "resolved", path: [[0, 0]], distance: 1, duration: 1 };

function setup(over: Partial<PageLookupDeps> = {}) {
  const geocoded: string[] = [];
  const routed: number[] = [];
  const existing: UiLookups = {
    ...NO_LOOKUPS,
    places: {
      Innsbruck: { status: "resolved", lat: 47.26543, lng: 11.39277 },
      // A second anchor nearby makes a region, as the streaming resolver requires.
      Salzburg: { status: "resolved", lat: 47.80949, lng: 13.05501 },
    },
  };
  const deps: PageLookupDeps = {
    off: false,
    code: `${CODE}\n<pin place="Salzburg"/>`,
    existing,
    geocode: (query) =>
      Effect.sync(() => {
        geocoded.push(query);
        return MATCHES[query] ?? [];
      }),
    route: (_mode, stops) =>
      Effect.sync(() => {
        routed.push(stops.length);
        return ROAD;
      }),
    ...over,
  };
  return { deps, geocoded, routed };
}

describe("resolvePageLookups", () => {
  it.effect("looks up only names written in the block, chosen by the block's places", () =>
    Effect.gen(function* () {
      const { deps, geocoded } = setup();
      const found = yield* resolvePageLookups(deps, {
        places: ["Munich", "my house", "Innsbruck"],
        routes: [],
      });
      // Typed by the reader, never sent; already placed, never asked again.
      expect(geocoded).toEqual(["Munich"]);
      expect(found.places).toEqual({
        Munich: { status: "resolved", lat: 48.13743, lng: 11.57549, name: "München, Deutschland" },
      });
    }),
  );

  it.effect("routes stops the answer has placed and skips those it has not", () =>
    Effect.gen(function* () {
      const { deps, routed } = setup();
      const kept = { mode: "drive" as const, stops: ["Innsbruck", "Salzburg"] };
      const unknown = { mode: "drive" as const, stops: ["Innsbruck", "Vienna"] };
      const coords = { mode: "walk" as const, stops: [{ lat: 1, lng: 2 }, "Salzburg"] };
      const found = yield* resolvePageLookups(deps, {
        places: [],
        routes: [kept, unknown, coords],
      });
      expect(Object.keys(found.routes).toSorted()).toEqual([routeKey(kept), routeKey(coords)].toSorted());
      expect(routed).toEqual([2, 2]);
    }),
  );

  it.effect("records a route over a place that was not found as unavailable", () =>
    Effect.gen(function* () {
      const { deps, routed } = setup({
        code: `<pin place="Atlantis"/>`,
      });
      const route = { mode: "bike" as const, stops: ["Atlantis", "Innsbruck"] };
      const found = yield* resolvePageLookups(deps, { places: ["Atlantis"], routes: [route] });
      expect(found.places.Atlantis).toEqual({ status: "unavailable" });
      expect(found.routes[routeKey(route)]).toEqual({ status: "unavailable" });
      expect(routed).toEqual([]);
    }),
  );

  it.effect("asks no service while maps are off", () =>
    Effect.gen(function* () {
      const { deps, geocoded, routed } = setup({ off: true });
      const route = { mode: "drive" as const, stops: ["Innsbruck", "Salzburg"] };
      const found = yield* resolvePageLookups(deps, { places: ["Munich"], routes: [route] });
      expect(found.places.Munich).toEqual({ status: "maps_off" });
      expect(found.routes[routeKey(route)]).toEqual({ status: "maps_off" });
      expect(geocoded).toEqual([]);
      expect(routed).toEqual([]);
    }),
  );

  it.effect("stops at the answer's cap", () =>
    Effect.gen(function* () {
      const many = Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`p${i}`, { status: "unavailable" as const }]),
      );
      const { deps, geocoded } = setup({ existing: { ...NO_LOOKUPS, places: many } });
      const found = yield* resolvePageLookups(deps, { places: ["Munich"], routes: [] });
      expect(found.places).toEqual({});
      expect(geocoded).toEqual([]);
    }),
  );
});
