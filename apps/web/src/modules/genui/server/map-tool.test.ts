import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import { routeKey } from "../extract.ts";
import type { MapRouteResult } from "../map-tool-schema.ts";
import type { PlaceCandidate } from "./map-lookups.ts";
import { MAP_ROUTE_CALLS, prepareMapRouteTool, type MapRouteDeps } from "./map-tool.ts";

const MATCHES: Record<string, PlaceCandidate[]> = {
  // Photon ranks the namesake an ocean away first.
  Munich: [
    { lat: 48.66917, lng: -98.83263, name: "Munich, United States" },
    { lat: 48.13743, lng: 11.57549, name: "München, Deutschland" },
  ],
  Innsbruck: [{ lat: 47.26543, lng: 11.39277, name: "Innsbruck, Österreich" }],
  Salzburg: [{ lat: 47.80949, lng: 13.05501, name: "Salzburg, Österreich" }],
};

const ROAD: UiRoute = {
  status: "resolved",
  path: [[11.39, 47.26]],
  distance: 290_000,
  duration: 11_000,
  legs: [
    { distance: 160_000, duration: 6000 },
    { distance: 130_000, duration: 5000 },
  ],
};

function setup(over: Partial<MapRouteDeps> = {}) {
  const routed: Array<{ mode: string; stops: number }> = [];
  const seeded: Array<{ places: Record<string, UiPlace>; routes: Record<string, UiRoute> }> = [];
  const group = prepareMapRouteTool({
    geocode: (query) => Effect.succeed(MATCHES[query] ?? []),
    route: (mode, stops) =>
      Effect.sync(() => {
        routed.push({ mode, stops: stops.length });
        return ROAD;
      }),
    seed: (update) =>
      Effect.sync(() => {
        seeded.push({ places: { ...update.places }, routes: { ...update.routes } });
      }),
    ...over,
  });
  const call = group.handlers.map_route as (params: unknown) => Effect.Effect<MapRouteResult>;
  return { call, routed, seeded };
}

describe("map_route", () => {
  it.effect("finds each stop in the light of the others and returns every leg", () =>
    Effect.gen(function* () {
      const { call, routed } = setup();
      const result = yield* call({ stops: ["Innsbruck", "Munich", "Salzburg"], mode: "bike" });
      expect(result).toMatchObject({
        outcome: "routed",
        mode: "bike",
        distance: 290_000,
        legs: ROAD.legs,
      });
      if (result.outcome !== "routed") throw new Error("not routed");
      expect(result.stops[1]).toMatchObject({ query: "Munich", lat: 48.13743 });
      expect(routed).toEqual([{ mode: "bike", stops: 3 }]);
    }),
  );

  it.effect("hands the answer the places and the route under a block's key", () =>
    Effect.gen(function* () {
      const { call, seeded } = setup();
      yield* call({ stops: ["Innsbruck", "47.81,13.06"] });
      expect(Object.keys(seeded[0]!.places)).toEqual(["Innsbruck"]);
      const key = routeKey({ mode: "drive", stops: ["Innsbruck", { lat: 47.81, lng: 13.06 }] });
      expect(seeded[0]!.routes[key]).toEqual(ROAD);
    }),
  );

  it.effect("explains malformed calls instead of failing", () =>
    Effect.gen(function* () {
      const { call, routed } = setup();
      for (const params of [
        {},
        { stops: ["Innsbruck"] },
        { stops: ["Innsbruck", 3] },
        { stops: ["Innsbruck", "Salzburg"], mode: "train" },
        { stops: ["Innsbruck", "91,0"] },
      ]) {
        expect(yield* call(params)).toMatchObject({ outcome: "rejected" });
      }
      expect(routed).toEqual([]);
    }),
  );

  it.effect("names the stops it could not find and routes nothing", () =>
    Effect.gen(function* () {
      const { call, routed, seeded } = setup();
      const result = yield* call({ stops: ["Innsbruck", "Atlantis"] });
      expect(result).toMatchObject({ outcome: "rejected" });
      if (result.outcome !== "rejected") throw new Error("routed");
      expect(result.message).toContain("Atlantis");
      expect(routed).toEqual([]);
      expect(seeded).toEqual([]);
    }),
  );

  it.effect("stops after its calls per answer", () =>
    Effect.gen(function* () {
      const { call } = setup();
      for (let i = 0; i < MAP_ROUTE_CALLS; i++)
        expect(yield* call({ stops: ["Innsbruck", "Salzburg"] })).toMatchObject({
          outcome: "routed",
        });
      expect(yield* call({ stops: ["Innsbruck", "Salzburg"] })).toMatchObject({
        outcome: "rejected",
      });
    }),
  );
});
