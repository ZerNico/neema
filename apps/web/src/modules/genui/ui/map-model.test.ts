import { describe, expect, it } from "vitest";
import { NO_LOOKUPS, type UiLookups } from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { routeKey } from "../extract.ts";
import { circleRing, resolveMap, routeSummary } from "./map-model.ts";

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
    expect(
      routeSummary(
        { key: "", mode: "drive", color: "", status: "ready", distance: 34000, duration: 2400 },
        "en",
      ),
    ).toBe("34 km · 40 min");
    expect(
      routeSummary(
        { key: "", mode: "walk", color: "", status: "ready", distance: 850, duration: 4000 },
        "en",
      ),
    ).toBe("850 m · 1 h 7 min");
  });
});

describe("circleRing", () => {
  it("closes the ring around the centre", () => {
    const ring = circleRing(52.5, 13.4, 1000, 8);
    expect(ring).toHaveLength(9);
    expect(ring[0]).toEqual(ring[8]);
  });
});
