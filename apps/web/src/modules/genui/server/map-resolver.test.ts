import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { UiPlace, UiRoute } from "~/modules/chat/assistant-output.ts";
import { routeKey } from "../extract.ts";
import type { PlaceCandidate } from "./map-lookups.ts";
import { makeMapResolver, type MapResolverDeps } from "./map-resolver.ts";

const block = (...lines: string[]) => ["```ui", "<map>", ...lines, "</map>", "```", ""].join("\n");

const COORDS: Record<string, { lat: number; lng: number }> = {
  "Ferry Building": { lat: 37.7955, lng: -122.3935 },
  "Coit Tower": { lat: 37.8024, lng: -122.4058 },
};

// Photon's real ranking: a namesake an ocean away comes first.
const MATCHES: Record<string, PlaceCandidate[]> = {
  Munich: [
    { lat: 48.66917, lng: -98.83263, name: "Munich, United States" },
    { lat: 48.13743, lng: 11.57549, name: "München, Deutschland" },
  ],
  Innsbruck: [{ lat: 47.26543, lng: 11.39277, name: "Innsbruck, Österreich" }],
  // The town first, then a hamlet of the same name a little nearer Zell am See.
  Mayrhofen: [
    { lat: 47.16667, lng: 11.86424, name: "Mayrhofen, Österreich" },
    { lat: 47.44611, lng: 12.83648, name: "Mayrhofen, Saalfelden am Steinernen Meer" },
  ],
  "Zell am See": [{ lat: 47.32396, lng: 12.79632, name: "Zell am See, Österreich" }],
  Krimml: [{ lat: 47.20838, lng: 12.17022, name: "Krimml, Österreich" }],
  Rome: [{ lat: 41.90278, lng: 12.49636, name: "Roma, Italia" }],
  // European capitals ranked first, each with an Ontario namesake near the others'.
  "London, Europe": [
    { lat: 51.50735, lng: -0.12776, name: "London, United Kingdom" },
    { lat: 42.98339, lng: -81.24653, name: "London, Ontario" },
  ],
  "Paris, Europe": [
    { lat: 48.85661, lng: 2.35222, name: "Paris, France" },
    { lat: 43.20001, lng: -80.38333, name: "Paris, Ontario" },
  ],
  "Brussels, Europe": [
    { lat: 50.84674, lng: 4.35247, name: "Brussels, Belgium" },
    { lat: 43.74328, lng: -81.25037, name: "Brussels, Ontario" },
  ],
  // The city first; its Lincolnshire namesake is the one near London.
  Boston: [
    { lat: 42.3601, lng: -71.0589, name: "Boston, United States" },
    { lat: 52.9789, lng: -0.0266, name: "Boston, United Kingdom" },
  ],
  // A world tour: Sydney's namesake in Nova Scotia is nearer London and New York.
  Sydney: [
    { lat: -33.86882, lng: 151.20929, name: "Sydney, Australia" },
    { lat: 46.13681, lng: -60.19422, name: "Sydney, Nova Scotia" },
  ],
  London: [{ lat: 51.50735, lng: -0.12776, name: "London, United Kingdom" }],
  "London, United Kingdom": [{ lat: 51.50735, lng: -0.12776, name: "London, United Kingdom" }],
  "New York": [{ lat: 40.71278, lng: -74.00597, name: "New York, United States" }],
};

const harness = (overrides: Partial<MapResolverDeps> = {}) => {
  const geocoded: string[] = [];
  const routed: Array<{ mode: string; stops: number }> = [];
  const places = new Map<string, UiPlace>();
  const placeWrites: string[] = [];
  const routes = new Map<string, UiRoute>();
  const deps: MapResolverDeps = {
    settled: { places: new Set(), routes: new Set() },
    known: new Map(),
    geocode: (query) =>
      Effect.sync(() => {
        geocoded.push(query);
        const found = COORDS[query];
        return MATCHES[query] ?? (found ? [found] : []);
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
        for (const [k, v] of Object.entries(update.places ?? {})) {
          placeWrites.push(k);
          places.set(k, v);
        }
        for (const [k, v] of Object.entries(update.routes ?? {})) routes.set(k, v);
      }),
    ...overrides,
  };
  return { deps, geocoded, routed, places, placeWrites, routes };
};

describe("map resolver", () => {
  it.effect("looks each place up once and routes between them when the fence closes", () =>
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
    }),
  );

  it.effect("draws a block's route from what the route tool already found, asking nothing", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeMapResolver(h.deps);
      const walk = routeKey({ mode: "walk", stops: ["Ferry Building", "Coit Tower"] });
      const road: UiRoute = { status: "resolved", path: [[0, 0]], distance: 2000, duration: 1500 };
      yield* resolver.seed({
        places: {
          "Ferry Building": { status: "resolved", ...COORDS["Ferry Building"] },
          "Coit Tower": { status: "resolved", ...COORDS["Coit Tower"] },
        },
        routes: { [walk]: road },
      });
      yield* resolver.observe(
        block(
          '<pin place="Coit Tower"/>',
          '<route mode="walk" stops={["Ferry Building", "Coit Tower"]}/>',
        ),
      );
      yield* resolver.drain;
      expect(h.geocoded).toEqual([]);
      expect(h.routed).toEqual([]);
      expect(h.routes.get(walk)).toEqual(road);
      expect(h.places.get("Coit Tower")).toMatchObject({ status: "resolved" });
    }),
  );

  it.effect("chooses among a name's matches by the other places on its map", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(block('<route stops={["Munich", "Innsbruck", "Zell am See"]}/>'));
      yield* resolver.drain;
      expect(h.places.get("Munich")).toMatchObject({ status: "resolved", lng: 11.57549 });
      // A trip that also reaches far is still regional where two places sit close.
      const far = harness();
      const reaching = yield* makeMapResolver(far.deps);
      yield* reaching.observe(
        block('<route stops={["Munich", "Innsbruck", "Zell am See", "Paris, Europe", "Rome"]}/>'),
      );
      yield* reaching.drain;
      expect(far.places.get("Munich")).toMatchObject({ lng: 11.57549 });
      // One neighbour is no region: London near Boston, Lincolnshire, proves nothing.
      const pair = harness();
      const transatlantic = yield* makeMapResolver(pair.deps);
      yield* transatlantic.observe(block('<route mode="straight" stops={["Boston", "London"]}/>'));
      yield* transatlantic.drain;
      expect(pair.places.get("Boston")).toMatchObject({ lng: -71.0589 });
      // Nor is one neighbour named twice.
      const twice = harness();
      const named = yield* makeMapResolver(twice.deps);
      yield* named.observe(
        block('<route mode="straight" stops={["Boston", "London", "London, United Kingdom"]}/>'),
      );
      yield* named.drain;
      expect(twice.places.get("Boston")).toMatchObject({ lng: -71.0589 });
      // Namesakes clustered elsewhere do not outvote the ranked matches.
      const capitals = harness();
      const europe = yield* makeMapResolver(capitals.deps);
      yield* europe.observe(
        block(
          '<route mode="straight" stops={["London, Europe", "Paris, Europe", "Brussels, Europe"]}/>',
        ),
      );
      yield* europe.drain;
      expect(capitals.places.get("London, Europe")).toMatchObject({ lng: -0.12776 });
      expect(capitals.places.get("Paris, Europe")).toMatchObject({ lng: 2.35222 });
      // Alone on its map, the geocoder's first match stands.
      const alone = harness();
      const single = yield* makeMapResolver(alone.deps);
      yield* single.observe(block('<pin place="Munich"/>'));
      yield* single.drain;
      expect(alone.places.get("Munich")).toMatchObject({ lng: -98.83263 });
      // Nearness only breaks outliers: a closer hamlet does not beat the town.
      const valley = harness();
      const trip = yield* makeMapResolver(valley.deps);
      yield* trip.observe(block('<route stops={["Zell am See", "Krimml", "Mayrhofen"]}/>'));
      yield* trip.drain;
      expect(valley.places.get("Mayrhofen")).toMatchObject({ lng: 11.86424 });
    }),
  );

  it.effect("records a route through an unknown place as unavailable without routing it", () =>
    Effect.gen(function* () {
      const h = harness();
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(block('<route stops={["Ferry Building", "Atlantis"]}/>'));
      yield* resolver.drain;
      expect(h.routed).toEqual([]);
      expect(h.places.get("Atlantis")).toEqual({ status: "unavailable" });
      expect([...h.routes.values()]).toEqual([{ status: "unavailable" }]);
    }),
  );

  it.effect(
    "routes from coordinates and places an earlier attempt resolved, without asking again",
    () =>
      Effect.gen(function* () {
        const h = harness({
          settled: { places: new Set(["Ferry Building"]), routes: new Set() },
          known: new Map([
            ["Ferry Building", { status: "resolved", ...COORDS["Ferry Building"]! }],
          ]),
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
      }),
  );

  it.effect(
    "keeps a world tour's ranking, writes a shared place once, and routes a padded stop",
    () =>
      Effect.gen(function* () {
        const tour = harness();
        const world = yield* makeMapResolver(tour.deps);
        yield* world.observe(
          block('<route mode="straight" stops={["Sydney", "London", "New York"]}/>'),
        );
        yield* world.drain;
        expect(tour.places.get("Sydney")).toMatchObject({ lng: 151.20929 });

        const h = harness();
        const resolver = yield* makeMapResolver(h.deps);
        // Two blocks name Munich; the second closes while the first decides.
        const first = block('<route stops={["Munich ", "Innsbruck", "Zell am See"]}/>');
        yield* resolver.observe(first + block('<pin place="Munich"/>'));
        yield* resolver.drain;
        expect(h.placeWrites.filter((name) => name === "Munich")).toEqual(["Munich"]);
        expect(h.places.get("Munich")).toMatchObject({ lng: 11.57549 });
        // The stray space named the same place, so the route did not wait for nothing.
        expect([...h.routes.values()]).toEqual([expect.objectContaining({ status: "resolved" })]);
      }),
  );

  it.effect("lets the first block naming a place decide it, however the lookups land", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const base = harness();
      const h = harness({
        // Innsbruck answers last, after the Munich-only block could have settled.
        geocode: (query) =>
          query === "Innsbruck"
            ? Deferred.await(gate).pipe(Effect.andThen(base.deps.geocode(query)))
            : base.deps.geocode(query),
      });
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(
        block('<route stops={["Munich", "Innsbruck", "Zell am See"]}/>') +
          block('<pin place="Munich"/>'),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* resolver.drain;
      expect(h.places.get("Munich")).toMatchObject({ lng: 11.57549 });
    }),
  );

  it.effect("writes decisions the drain deadline cut off, not unavailable", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const h = harness();
      let stalled = false;
      const record = h.deps.record;
      const resolver = yield* makeMapResolver({
        ...h.deps,
        // The first write hangs past the deadline; the decisions behind it stand.
        record: (update) => {
          if (stalled || !update.places?.["Ferry Building"]) return record(update);
          stalled = true;
          return Deferred.await(never);
        },
      });
      yield* resolver.observe(
        block(
          '<pin place="Ferry Building"/>',
          '<pin place="Coit Tower"/>',
          '<route mode="walk" stops={["Ferry Building", "Coit Tower"]}/>',
        ),
      );
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("12 seconds");
      yield* Fiber.join(draining);
      expect(h.places.get("Ferry Building")).toMatchObject({ status: "resolved" });
      expect(h.places.get("Coit Tower")).toMatchObject({ status: "resolved" });
      // Both were handed to the route before the stalled write.
      expect([...h.routes.values()]).toEqual([expect.objectContaining({ status: "resolved" })]);
    }),
  );

  it.effect("still routes between places that arrived when another lookup hangs", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<ReadonlyArray<PlaceCandidate>>();
      const base = harness();
      const h = harness({
        geocode: (query) => (query === "Slow" ? Deferred.await(never) : base.deps.geocode(query)),
        route: (mode, stops) => {
          h.routed.push({ mode, stops: stops.length });
          // Over the network: a route still running at the cut is lost.
          return Effect.delay(base.deps.route(mode, stops), "1 second");
        },
      });
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(
        block(
          '<pin place="Slow"/>',
          '<route mode="walk" stops={["Ferry Building", "Coit Tower"]}/>',
        ),
      );
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("12 seconds");
      yield* Fiber.join(draining);
      expect(h.routed).toEqual([{ mode: "walk", stops: 2 }]);
      expect([...h.routes.values()]).toEqual([expect.objectContaining({ status: "resolved" })]);
      expect(h.places.get("Slow")).toEqual({ status: "unavailable" });
    }),
  );

  it.effect("stops waiting at the drain limit and records what is left as unavailable", () =>
    Effect.gen(function* () {
      const never = yield* Deferred.make<ReadonlyArray<PlaceCandidate>>();
      const base = harness();
      const h = harness({
        geocode: (query) => (query === "Slow" ? Deferred.await(never) : base.deps.geocode(query)),
      });
      const resolver = yield* makeMapResolver(h.deps);
      yield* resolver.observe(
        block('<pin place="Slow"/>', '<route stops={["Slow", "Coit Tower"]}/>'),
      );
      const draining = yield* Effect.forkChild(resolver.drain);
      yield* TestClock.adjust("12 seconds");
      yield* Fiber.join(draining);
      expect(h.places.get("Slow")).toEqual({ status: "unavailable" });
      // Its neighbour came back in time and is not lost with it.
      expect(h.places.get("Coit Tower")).toMatchObject({ status: "resolved" });
      expect([...h.routes.values()]).toEqual([{ status: "unavailable" }]);
    }),
  );
});
