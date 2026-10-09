import { describe, expect, it } from "vitest";
import { NO_LOOKUPS, type UiLookups } from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { routeKey } from "../extract.ts";
import { circleRing, mapNeeds, partialPath, resolveMap, routeSummary } from "./map-model.ts";

const el = (tag: string, props: Record<string, unknown>, children: ValidNode["children"] = []) =>
  ({ tag, props, children }) as ValidNode;

const map = el("map", { label: "Trip" }, [
  el("pin", { id: "hbf", place: "Berlin  Hauptbahnhof", label: "Station" }, ["Trains"]),
  el("pin", { lat: 52.39, lng: 13.06 }),
  el("pin", { place: "Atlantis" }),
  el("pin", { place: "Not yet" }),
  el("route", { mode: "drive", stops: ["Berlin Hauptbahnhof", "Potsdam"] }),
  el("route", { mode: "straight", stops: ["Berlin Hauptbahnhof", { lat: 52.39, lng: 13.06 }] }),
  el("area", { lat: 52.5, lng: 13.4, radius: 500, label: "Centre" }),
]);

const lookups: UiLookups = {
  ...NO_LOOKUPS,
  places: {
    "Berlin Hauptbahnhof": { status: "resolved", lat: 52.525, lng: 13.369 },
    Atlantis: { status: "unavailable" },
  },
  routes: {
    [routeKey({ mode: "drive", stops: ["Berlin Hauptbahnhof", "Potsdam"] })]: {
      status: "resolved",
      path: [
        [13.369, 52.525],
        [13.06, 52.39],
      ],
      distance: 34000,
      duration: 2400,
    },
  },
};

describe("resolveMap", () => {
  it("places pins from lookups or their own coordinates", () => {
    const { pins } = resolveMap(map, lookups, false);
    expect(pins.map((p) => [p.id, p.status, p.lat])).toEqual([
      ["hbf", "ready", 52.525],
      ["pin-1", "ready", 52.39],
      ["pin-2", "missing", undefined],
      ["pin-3", "missing", undefined],
    ]);
    expect(pins[0]!.label).toBe("Station");
    expect(pins[0]!.content).toEqual(["Trains"]);
  });

  it("waits for a lookup while the answer streams and gives up once it has ended", () => {
    expect(resolveMap(map, NO_LOOKUPS, true).pins[0]!.status).toBe("pending");
    expect(resolveMap(map, NO_LOOKUPS, false).pins[0]!.status).toBe("missing");
  });

  it("draws routed paths as stored and straight lines from the places", () => {
    const [drive, straight] = resolveMap(map, lookups, false).routes;
    expect(drive).toMatchObject({ status: "ready", distance: 34000, duration: 2400 });
    expect(straight).toMatchObject({
      status: "ready",
      path: [
        [13.369, 52.525],
        [13.06, 52.39],
      ],
    });
    expect(straight!.distance).toBeUndefined();
  });

  it("keeps areas with a centre and a radius", () => {
    expect(resolveMap(map, lookups, false).areas).toEqual([
      { lat: 52.5, lng: 13.4, radius: 500, label: "Centre", color: "chart-1" },
    ]);
  });
});

describe("resolveMap with maps off", () => {
  it("says so for places and routes instead of not finding them", () => {
    const off: UiLookups = {
      ...NO_LOOKUPS,
      places: { "Berlin Hauptbahnhof": { status: "maps_off" }, Potsdam: { status: "maps_off" } },
      routes: {
        [routeKey({ mode: "drive", stops: ["Berlin Hauptbahnhof", "Potsdam"] })]: {
          status: "maps_off",
        },
      },
    };
    const { pins, routes } = resolveMap(map, off, false);
    expect(pins[0]!.status).toBe("off");
    expect(routes.map((r) => r.status)).toEqual(["off", "off"]);
  });
});

describe("routeSummary", () => {
  it("says distance and time", () => {
    expect(routeSummary({ distance: 34000, duration: 2400 }, "en")).toBe("34 km · 40 min");
    expect(routeSummary({ distance: 850, duration: 4000 }, "en")).toBe("850 m · 1 h 7 min");
    expect(routeSummary({ distance: 850 }, "en")).toBeNull();
  });
});

describe("circleRing", () => {
  it("keeps valid latitudes at a pole and a continuous ring across the date line", () => {
    for (const [x, y] of circleRing(90, 0, 200_000)) {
      expect(Math.abs(y)).toBeLessThanOrEqual(90);
      expect(Number.isFinite(x)).toBe(true);
    }
    // Fiji: wrapped into ±180, neighbouring points would sit 360° apart.
    const fiji = circleRing(-17, 179.9, 50_000);
    const jumps = fiji.slice(1).map(([x], i) => Math.abs(x - fiji[i]![0]));
    expect(Math.max(...jumps)).toBeLessThan(1);
    expect(Math.max(...fiji.map(([x]) => x))).toBeGreaterThan(180);
  });

  it("puts each point at the radius from the centre", () => {
    const [east] = circleRing(0, 0, 111_195, 4).slice(1);
    // A quarter turn from north: due east, one degree along the equator.
    expect(east![0]).toBeCloseTo(1, 3);
    expect(east![1]).toBeCloseTo(0, 6);
  });

  it("closes the ring around the centre", () => {
    const ring = circleRing(52.5, 13.4, 1000, 8);
    expect(ring).toHaveLength(9);
    expect(ring[0]).toEqual(ring[8]);
  });
});

describe("mapNeeds", () => {
  it("asks for places and roads without a result, never for straight lines or coordinates", () => {
    const needs = mapNeeds(map, lookups);
    expect(needs.places).toEqual(["Not yet", "Potsdam"]);
    expect(needs.routes).toEqual([]);
    const kept = el("map", { label: "Kept" }, [
      el("route", { mode: "walk", stops: ["Berlin Hauptbahnhof", { lat: 52.39, lng: 13.06 }] }),
      el("route", { mode: "straight", stops: ["Berlin Hauptbahnhof", "Somewhere"] }),
    ]);
    expect(mapNeeds(kept, lookups)).toEqual({
      places: ["Somewhere"],
      routes: [{ mode: "walk", stops: ["Berlin Hauptbahnhof", { lat: 52.39, lng: 13.06 }] }],
    });
  });

  it("shows what has no result as pending while it is asked for, missing after", () => {
    const pin = el("map", { label: "One" }, [el("pin", { place: "Not yet" })]);
    expect(resolveMap(pin, lookups, true).pins[0]!.status).toBe("pending");
    expect(resolveMap(pin, lookups, false).pins[0]!.status).toBe("missing");
  });
});

describe("partialPath", () => {
  const path = [
    [0, 0],
    [1, 0],
    [1, 3],
  ] as const;

  it("ends partway along the segment the share reaches, by length", () => {
    expect(partialPath(path, 0.5)).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(partialPath(path, 0)).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("returns the whole path at the end", () => {
    expect(partialPath(path, 1)).toEqual(path.map(([x, y]) => [x, y]));
  });
});
