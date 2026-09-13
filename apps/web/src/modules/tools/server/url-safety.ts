import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
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

// Private/reserved IPv4 ranges we refuse to fetch result pages from.
const isPrivateIpv4 = (ip: string): boolean => {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 192 && b === 0) || // 192.0.0/24 special
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
};

const ipv6PartGroups = (part: string): number[] => {
  if (part === "") return [];
  return part.split(":").map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return Number.NaN;
    return Number.parseInt(group, 16);
  });
};

/** Eight 16-bit groups, or null when the literal cannot be decoded. */
const ipv6Groups = (ip: string): number[] | null => {
  const bare = ip.toLowerCase().split("%")[0]!;
  let encoded = bare;
  const ipv4Tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (ipv4Tail) {
    const octets = ipv4Tail[1]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet > 255 || Number.isNaN(octet)))
      return null;
    const hi = (octets[0]! << 8) | octets[1]!;
    const lo = (octets[2]! << 8) | octets[3]!;
    encoded = `${bare.slice(0, ipv4Tail.index + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = encoded.split("::");
  if (halves.length > 2) return null;
  const left = ipv6PartGroups(halves[0]!);
  const right = halves.length === 2 ? ipv6PartGroups(halves[1]!) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1) return missing === 0 ? left : null;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

const ipv4FromGroups = (high: number, low: number) =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

const isPrivateIpv6 = (ip: string): boolean => {
  const groups = ipv6Groups(ip);
  // Fail closed on a literal `isIP` accepted but we could not expand.
  if (!groups) return true;
  const zeroHead = (count: number) => groups.slice(0, count).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true; // ::
  if (zeroHead(7) && groups[7] === 1) return true; // ::1
  if ((groups[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((groups[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((groups[0]! & 0xff00) === 0xff00) return true; // multicast
  // IPv4-mapped ::ffff:x:x, IPv4-translated ::ffff:0:x:x, IPv4-compatible ::x:x.
  if (zeroHead(5) && groups[5] === 0xffff) return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  if (zeroHead(4) && groups[4] === 0xffff && groups[5] === 0)
    return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  if (zeroHead(6)) return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  // NAT64 well-known prefix 64:ff9b::/96 (groups 2-5 are the prefix padding).
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
    return isPrivateIpv4(ipv4FromGroups(groups[6]!, groups[7]!));
  // 6to4 2002:x:x:: embeds the IPv4 address in the next 32 bits.
  if (groups[0] === 0x2002) return isPrivateIpv4(ipv4FromGroups(groups[1]!, groups[2]!));
  return false;
};

const isPrivateIp = (ip: string): boolean =>
  isIP(ip) === 4 ? isPrivateIpv4(ip) : isPrivateIpv6(ip);

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
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: incoming.statusCode ?? 0,
            statusText: incoming.statusMessage ?? "",
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
