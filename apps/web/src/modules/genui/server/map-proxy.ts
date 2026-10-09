// Map styles, tiles, sprites and fonts, fetched by the server for the reader.
// The browser then never asks the tile provider anything, so it learns
// nothing about who looks at which place, and the page's CSP stays as it is.
// It is not an open proxy: only the hosts the configured styles live on are
// reached, and JSON from them is rewritten to point back here.

import type { MapServices } from "../settings.ts";

const USER_AGENT = "neema/1.0 (self-hosted chat; maps in answers)";
const MAX_BODY = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** Cached bytes across all entries; the oldest go first. */
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * What a map is made of. Anything else, HTML or script above all, would run on
 * this server's origin if passed through, so it is refused whatever the host.
 */
const MAP_TYPES = new Set([
  "application/json",
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile",
  "application/octet-stream",
  "image/png",
  "image/webp",
  "image/jpeg",
]);
/** The upstream type when it is one a map needs, without parameters; otherwise null. */
export function mapType(contentType: string): string | null {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return MAP_TYPES.has(type) ? type : null;
}

interface Cached {
  readonly body: Uint8Array;
  readonly type: string;
  readonly at: number;
}
const cache = new Map<string, Cached>();
let cachedBytes = 0;

function remember(key: string, entry: Cached) {
  if (entry.body.byteLength > CACHE_BYTES / 8) return;
  const old = cache.get(key);
  if (old) {
    cachedBytes -= old.body.byteLength;
    cache.delete(key);
  }
  cache.set(key, entry);
  cachedBytes += entry.body.byteLength;
  for (const [k, v] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cachedBytes -= v.body.byteLength;
  }
}

/** For tests: forget everything fetched. */
export function clearMapCache() {
  cache.clear();
  cachedBytes = 0;
}

const hostsOf = (services: MapServices) =>
  new Set([new URL(services.styleLight).host, new URL(services.styleDark).host]);

/** Absolute URLs on an allowed host become this server's proxy URLs. */
export function rewriteMapJson(text: string, hosts: ReadonlySet<string>, origin: string): string {
  let out = text;
  for (const host of hosts) {
    out = out.split(`https://${host}/`).join(`${origin}/api/map/t/${host}/`);
  }
  return out;
}

/** The upstream URL for a proxy path, or null when it would leave the allowed hosts. */
export function upstreamFor(
  splat: string,
  search: string,
  services: MapServices,
): { url: URL; host: string } | null {
  if (splat === "style/light" || splat === "style/dark") {
    const url = new URL(splat === "style/light" ? services.styleLight : services.styleDark);
    return { url, host: url.host };
  }
  const match = /^t\/([^/]+)\/(.+)$/.exec(splat);
  if (!match) return null;
  const [, host, path] = match;
  if (!host || !path || !hostsOf(services).has(host)) return null;
  if (path.split("/").some((part) => part === ".." || part === ".")) return null;
  const url = new URL(`https://${host}/${path}${search}`);
  // Encoded tricks that normalise into another host or scheme are refused.
  return url.host === host && url.protocol === "https:" ? { url, host } : null;
}

async function fetchCapped(url: URL): Promise<{ body: Uint8Array; type: string } | null> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT },
    redirect: "error",
  });
  if (!response.ok || !response.body) return null;
  const type = mapType(response.headers.get("content-type") ?? "application/octet-stream");
  if (!type) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return { body, type };
}

/**
 * Answers one proxied map request. The caller has checked the session and
 * that maps are on; this only decides what may be fetched and how it returns.
 */
export async function proxyMap(
  splat: string,
  requestUrl: URL,
  services: MapServices,
  /** Where readers reach this server; behind a TLS proxy the request's own origin is plain http. */
  origin = requestUrl.origin,
): Promise<Response> {
  const target = upstreamFor(splat, requestUrl.search, services);
  if (!target) return new Response("Not found", { status: 404 });
  const key = target.url.href;
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || now - entry.at > CACHE_MS) {
    let fetched: { body: Uint8Array; type: string } | null;
    try {
      fetched = await fetchCapped(target.url);
    } catch {
      fetched = null;
    }
    if (!fetched) return new Response("Map service unavailable", { status: 502 });
    entry = { ...fetched, at: now };
    remember(key, entry);
  }
  const json = entry.type === "application/json";
  const body = json
    ? rewriteMapJson(new TextDecoder().decode(entry.body), hostsOf(services), origin)
    : new Blob([entry.body.slice()]);
  return new Response(body, {
    headers: {
      "content-type": entry.type,
      "x-content-type-options": "nosniff",
      // Never a document: even a mislabelled body opened directly has no script and no origin.
      "content-security-policy": "default-src 'none'; sandbox",
      // Styles name versioned tile sets, so they may change; tiles under one version do not.
      "cache-control": json ? "private, max-age=3600" : "private, max-age=86400",
    },
  });
}
