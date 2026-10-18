import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { addressRefusal } from "@chat/egress-proxy/address";
import { Effect, Schema } from "effect";

export class UnsafeUrl extends Schema.TaggedError<UnsafeUrl>()("UnsafeUrl", {
  url: Schema.String,
  reason: Schema.String,
}) {}

export interface PublicHttpTarget {
  readonly url: URL;
  /** Addresses `fetchPinned` will connect to; DNS is not consulted again. */
  readonly addresses: ReadonlyArray<LookupAddress>;
}

// One classifier for every way out: the desktop's egress proxy decides the same addresses.
const isPrivateIp = (ip: string): boolean => addressRefusal(ip, [], false) !== null;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);

const asAddresses = (hostname: string): LookupAddress[] => [
  { address: hostname, family: isIP(hostname) },
];

/**
 * Validates that a result URL is safe to fetch: http(s) only, no credentials,
 * hostname not local, and every resolved address public. Callers must connect
 * through `fetchPinned` so DNS is not consulted a second time.
 */
export const resolvePublicHttpUrl = (rawUrl: string): Effect.Effect<PublicHttpTarget, UnsafeUrl> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(rawUrl),
      catch: () => new UnsafeUrl({ url: rawUrl, reason: "invalid URL" }),
    });
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* new UnsafeUrl({ url: rawUrl, reason: `unsupported protocol ${url.protocol}` });
    }
    if (url.username || url.password) {
      return yield* new UnsafeUrl({ url: rawUrl, reason: "embedded credentials" });
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase()) || !hostname.includes(".")) {
      if (isIP(hostname) === 0) {
        return yield* new UnsafeUrl({ url: rawUrl, reason: "local hostname" });
      }
    }
    if (isIP(hostname) !== 0) {
      if (isPrivateIp(hostname)) {
        return yield* new UnsafeUrl({ url: rawUrl, reason: "private address" });
      }
      return { url, addresses: asAddresses(hostname) };
    }
    const addresses = yield* Effect.tryPromise({
      try: () => lookup(hostname, { all: true }),
      catch: () => new UnsafeUrl({ url: rawUrl, reason: "DNS resolution failed" }),
    });
    if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
      return yield* new UnsafeUrl({ url: rawUrl, reason: "resolves to private address" });
    }
    return { url, addresses };
  });

export const assertPublicHttpUrl = (rawUrl: string): Effect.Effect<URL, UnsafeUrl> =>
  Effect.map(resolvePublicHttpUrl(rawUrl), (target) => target.url);

/** `net` lookup that ignores the hostname and returns the already-checked addresses. */
export const lookupPinned =
  (addresses: readonly LookupAddress[]): LookupFunction =>
  (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) return;
    const opts = typeof options === "function" ? {} : options;
    const family = opts.family ?? 0;
    const matched =
      family === 0 ? addresses : addresses.filter((address) => address.family === family);
    const chosen = matched.length > 0 ? matched : addresses;
    if (chosen.length === 0) {
      const error = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      cb(error as NodeJS.ErrnoException, "", 0);
      return;
    }
    if (opts.all) {
      (cb as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [
        ...chosen,
      ]);
      return;
    }
    cb(null, chosen[0]!.address, chosen[0]!.family);
  };

const requestHeaders = (init?: RequestInit): Record<string, string> => {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Fetches `target.url` by connecting to `target.addresses` only. `fetch` would
 * resolve DNS again and reopen the rebinding window `resolvePublicHttpUrl` closed.
 */
export const fetchPinned = (target: PublicHttpTarget, init: RequestInit = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const requestFn = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      target.url,
      {
        method: init.method ?? "GET",
        headers: requestHeaders(init),
        lookup: lookupPinned(target.addresses),
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headersDistinct)) {
          if (!value) continue;
          for (const item of value) headers.append(key, item);
        }
        const status = incoming.statusCode ?? 0;
        // These answers carry no body, and `Response` throws if given one. A
        // throw here escapes the promise and takes the process down.
        const bodyless = NULL_BODY_STATUSES.has(status);
        if (bodyless) incoming.resume();
        try {
          resolve(
            new Response(
              bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, statusText: incoming.statusMessage ?? "", headers },
            ),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    req.on("error", reject);
    // Bytes or text only: a stream body would need its own error handling.
    const body = init.body;
    if (typeof body === "string" || body instanceof Uint8Array) req.end(body);
    else req.end();
  });
