import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import { routeKey } from "../extract.ts";
import { makeMapResolver, type MapResolverDeps } from "./map-resolver.ts";

const block = (...lines: string[]) => ["```ui", "<map>", ...lines, "</map>", "```", ""].join("\n");

const COORDS: Record<string, { lat: number; lng: number }> = {
  "Ferry Building": { lat: 37.7955, lng: -122.3935 },
  "Coit Tower": { lat: 37.8024, lng: -122.4058 },
};

const harness = (overrides: Partial<MapResolverDeps> = {}) => {
  const geocoded: string[] = [];
  const routed: Array<{ mode: string; stops: number }> = [];
  const places = new Map<string, UiPlace>();
  const routes = new Map<string, UiRoute>();
  const deps: MapResolverDeps = {
    settled: { places: new Set(), routes: new Set() },
    known: new Map(),
    geocode: (query) =>
      Effect.sync(() => {
        geocoded.push(query);
        const found = COORDS[query];
        return found
          ? { status: "resolved" as const, ...found }
          : { status: "unavailable" as const };
      }),
    route: (mode, stops) =>
      Effect.sync(() => {
        routed.push({ mode, stops: stops.length });
        return {
          status: "resolved" as const,
          path: [
            [0, 0],
            [1, 1],
          ],
          distance: 1720,
          duration: 1376,
        };
      }),
    record: (update) =>
      Effect.sync(() => {
        for (const [k, v] of Object.entries(update.places ?? {})) places.set(k, v);
        for (const [k, v] of Object.entries(update.routes ?? {})) routes.set(k, v);
      }),
    ...overrides,
  };
  return { deps, geocoded, routed, places, routes };
};

describe("map resolver", () => {
  it("looks each place up once and routes between them when the fence closes", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeMapResolver(h.deps);
      const text = block(
        '<pin place="Ferry Building"/>',
        '<pin place="Coit Tower"/>',
        '<route mode="walk" stops={["Ferry Building", "Coit Tower"]}/>',
        '<route mode="straight" stops={["Ferry Building", "Coit Tower"]}/>',
      );
      // Still open: nothing yet.
      yield* resolver.observe(text.slice(0, text.indexOf("</map>")));
      expect(h.geocoded).toEqual([]);
      yield* resolver.observe(text);
      yield* resolver.observe(text + "More text.");
      yield* resolver.drain;
      expect(h.geocoded).toEqual(["Ferry Building", "Coit Tower"]);
      expect(h.routed).toEqual([{ mode: "walk", stops: 2 }]);
      expect(h.places.get("Coit Tower")).toEqual({ status: "resolved", ...COORDS["Coit Tower"] });
      const walk = routeKey({ mode: "walk", stops: ["Ferry Building", "Coit Tower"] });
      expect(h.routes.get(walk)).toMatchObject({ status: "resolved", distance: 1720 });
      // A straight line is the page's to draw from the places.
      expect([...h.routes.keys()]).toEqual([walk]);
    }));

  it("records a route through an unknown place as unavailable without routing it", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(block('<route stops={["Ferry Building", "Atlantis"]}/>'));
      yield* resolver.drain;
      expect(h.routed).toEqual([]);
      expect(h.places.get("Atlantis")).toEqual({ status: "unavailable" });
      expect([...h.routes.values()]).toEqual([{ status: "unavailable" }]);
    }));

  it("routes from coordinates and places an earlier attempt resolved, without asking again", () =>
    Effect.gen(function* () {
      const h = harness({
        settled: { places: new Set(["Ferry Building"]), routes: new Set() },
        known: new Map([["Ferry Building", { status: "resolved", ...COORDS["Ferry Building"]! }]]),
      });
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(
        block('<route mode="bike" stops={["Ferry Building", { lat: 37.8, lng: -122.41 }]}/>'),
      );
      yield* resolver.drain;
      expect(h.geocoded).toEqual([]);
      expect(h.routed).toEqual([{ mode: "bike", stops: 2 }]);
      // Settled before: not recorded twice.
      expect(h.places.size).toBe(0);
    }));

  it("stops waiting at the drain limit and records what is left as unavailable", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<UiPlace>();
      const h = harness({ geocode: () => Deferred.await(never) });
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(
        block('<pin place="Slow"/>', '<route stops={["Slow", "Coit Tower"]}/>'),
      );
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("9 seconds");
      yield* Fiber.join(draining);
      expect(h.places.get("Slow")).toEqual({ status: "unavailable" });
      expect([...h.routes.values()]).toEqual([{ status: "unavailable" }]);
    }));
});
