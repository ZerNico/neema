import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { MAP_SERVICE_DEFAULTS } from "../settings.ts";
import { MapLookups, thinPath } from "./map-lookups.ts";

const run = <A>(effect: Effect.Effect<A, never, MapLookups>) =>
  Effect.runPromise(effect.pipe(Effect.provide(MapLookups.layer)));

const stubFetch = (answer: (url: URL) => Response) => {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL, init?: RequestInit) => {
      urls.push(input);
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/^neema\//);
      return answer(input);
    }),
  );
  return urls;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MapLookups", () => {
  it("finds a place through Photon and names it", async () => {
    const urls = stubFetch(() =>
      Response.json({
        features: [
          {
            geometry: { type: "Point", coordinates: [-122.3934746, 37.7955487] },
            properties: { name: "Ferry Building", city: "San Francisco", country: "United States" },
          },
        ],
      }),
    );
    const place = await run(
      MapLookups.use((maps) => maps.geocode(MAP_SERVICE_DEFAULTS, "Ferry Building, SF")),
    );
    expect(urls[0]!.href).toBe("https://photon.komoot.io/api?q=Ferry+Building%2C+SF&limit=5");
    expect(place).toEqual([
      { lat: 37.79555, lng: -122.39347, name: "Ferry Building, San Francisco, United States" },
    ]);
  });

  it("routes on the profile for the mode and reports distance and time", async () => {
    const urls = stubFetch(() =>
      Response.json({
        code: "Ok",
        routes: [
          {
            distance: 1720.4,
            duration: 1376.2,
            geometry: {
              coordinates: [
                [-122.393435, 37.795538],
                [-122.4058, 37.8024],
              ],
            },
          },
        ],
      }),
    );
    const route = await run(
      MapLookups.use((maps) =>
        maps.route(MAP_SERVICE_DEFAULTS, "walk", [
          { lat: 37.7955, lng: -122.3935 },
          { lat: 37.8024, lng: -122.4058 },
        ]),
      ),
    );
    expect(urls[0]!.pathname).toBe(
      "/routed-foot/route/v1/driving/-122.3935,37.7955;-122.4058,37.8024",
    );
    expect(route).toEqual({
      status: "resolved",
      path: [
        [-122.39343, 37.79554],
        [-122.4058, 37.8024],
      ],
      distance: 1720,
      duration: 1376,
    });
  });

  it("answers unavailable for no match, an error status or a malformed body", async () => {
    stubFetch(() => Response.json({ features: [] }));
    expect(await run(MapLookups.use((m) => m.geocode(MAP_SERVICE_DEFAULTS, "Atlantis")))).toEqual(
      [],
    );
    stubFetch(() => new Response("busy", { status: 429 }));
    expect(await run(MapLookups.use((m) => m.geocode(MAP_SERVICE_DEFAULTS, "x")))).toEqual([]);
    stubFetch(() => Response.json({ code: "NoRoute" }));
    expect(
      await run(
        MapLookups.use((m) =>
          m.route(MAP_SERVICE_DEFAULTS, "drive", [
            { lat: 0, lng: 0 },
            { lat: 1, lng: 1 },
          ]),
        ),
      ),
    ).toEqual({ status: "unavailable" });
  });
});

describe("thinPath", () => {
  it("keeps the ends and at most the limit, rounded", () => {
    const points = Array.from({ length: 5000 }, (_, i) => [i / 1e6, i / 1e6] as const);
    const thin = thinPath(points, 100);
    expect(thin).toHaveLength(100);
    expect(thin[0]).toEqual([0, 0]);
    expect(thin.at(-1)).toEqual([0.005, 0.005]);
  });
});
