import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAP_SERVICE_DEFAULTS } from "../settings.ts";
import { clearMapCache, proxyMap, rewriteMapJson, upstreamFor } from "./map-proxy.ts";

const services = MAP_SERVICE_DEFAULTS;
const origin = "https://chat.example.org";
const at = (path: string) => new URL(`${origin}/api/map/${path}`);

let calls: string[] = [];
const stubFetch = (answer: (url: URL) => Response) => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      calls.push(url.href);
      return answer(url);
    }),
  );
};

beforeEach(() => clearMapCache());
afterEach(() => vi.unstubAllGlobals());

describe("upstreamFor", () => {
  it("serves the configured styles and paths on their hosts", () => {
    expect(upstreamFor("style/dark", "", services)?.url.href).toBe(services.styleDark);
    expect(upstreamFor("t/tiles.openfreemap.org/planet/1/2/3.pbf", "", services)?.url.href).toBe(
      "https://tiles.openfreemap.org/planet/1/2/3.pbf",
    );
  });

  it("refuses other hosts, traversal and anything else", () => {
    expect(upstreamFor("t/evil.example.org/x", "", services)).toBeNull();
    expect(upstreamFor("t/tiles.openfreemap.org/../admin", "", services)).toBeNull();
    expect(upstreamFor("t/tiles.openfreemap.org/a/./b", "", services)).toBeNull();
    expect(upstreamFor("t/tiles.openfreemap.org@evil.example.org/x", "", services)).toBeNull();
    expect(upstreamFor("style/other", "", services)).toBeNull();
    expect(upstreamFor("", "", services)).toBeNull();
  });
});

describe("rewriteMapJson", () => {
  it("points the allowed host's URLs back at this server and leaves others", () => {
    const json = JSON.stringify({
      sources: { omt: { url: "https://tiles.openfreemap.org/planet" } },
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      other: "https://elsewhere.example.org/x",
    });
    const out = JSON.parse(rewriteMapJson(json, new Set(["tiles.openfreemap.org"]), origin));
    expect(out.sources.omt.url).toBe(`${origin}/api/map/t/tiles.openfreemap.org/planet`);
    expect(out.glyphs).toBe(
      `${origin}/api/map/t/tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf`,
    );
    expect(out.other).toBe("https://elsewhere.example.org/x");
  });
});

describe("proxyMap", () => {
  it("rewrites a style, caches it, and passes tiles through untouched", async () => {
    stubFetch((url) =>
      url.pathname.endsWith(".pbf")
        ? new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/x-protobuf" },
          })
        : Response.json({ sprite: "https://tiles.openfreemap.org/sprites/ofm" }),
    );
    const style = await proxyMap("style/light", at("style/light"), services);
    expect(await style.json()).toEqual({
      sprite: `${origin}/api/map/t/tiles.openfreemap.org/sprites/ofm`,
    });
    await proxyMap("style/light", at("style/light"), services);
    expect(calls).toEqual([services.styleLight]);

    const tile = await proxyMap(
      "t/tiles.openfreemap.org/planet/1/2/3.pbf",
      at("t/tiles.openfreemap.org/planet/1/2/3.pbf"),
      services,
    );
    expect(new Uint8Array(await tile.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(tile.headers.get("cache-control")).toBe("private, max-age=86400");
  });

  it("refuses anything a map is not made of, so a page on an allowed host never runs here", async () => {
    stubFetch(
      () =>
        new Response("<script>fetch('/api/me')</script>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const page = await proxyMap(
      "t/tiles.openfreemap.org/uploads/x.html",
      at("t/tiles.openfreemap.org/uploads/x.html"),
      services,
    );
    expect(page.status).toBe(502);
    expect(await page.text()).not.toContain("<script>");
  });

  it("sends map assets with a sandbox policy and their bare type", async () => {
    stubFetch(
      () =>
        new Response(new Uint8Array([9]), {
          headers: { "content-type": "image/png; foo=bar" },
        }),
    );
    const sprite = await proxyMap(
      "t/tiles.openfreemap.org/sprites/ofm.png",
      at("t/tiles.openfreemap.org/sprites/ofm.png"),
      services,
    );
    expect(sprite.headers.get("content-type")).toBe("image/png");
    expect(sprite.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("answers 404 for a refused path and 502 when the service fails", async () => {
    stubFetch(() => new Response("down", { status: 503 }));
    expect(
      (await proxyMap("t/evil.example.org/x", at("t/evil.example.org/x"), services)).status,
    ).toBe(404);
    expect((await proxyMap("style/dark", at("style/dark"), services)).status).toBe(502);
    expect(calls).toEqual([services.styleDark]);
  });
});
