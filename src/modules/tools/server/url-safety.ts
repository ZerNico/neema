import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Effect, Schema } from "effect";

export class UnsafeUrl extends Schema.TaggedError<UnsafeUrl>()("UnsafeUrl", {
  url: Schema.String,
  reason: Schema.String,
}) {}

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

const isPrivateIpv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  // Normalize away zone id
  const bare = lower.split("%")[0]!;
  if (bare === "::" || bare === "::1") return true;
  if (
    bare.startsWith("fe8") ||
    bare.startsWith("fe9") ||
    bare.startsWith("fea") ||
    bare.startsWith("feb")
  )
    return true; // link-local fe80::/10
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // ULA fc00::/7
  if (bare.startsWith("ff")) return true; // multicast
  // IPv4-mapped: URL normalizes to hex form (::ffff:c0a8:1), but accept the
  // dotted form too.
  const v4Dotted = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Dotted) return isPrivateIpv4(v4Dotted[1]!);
  const v4Hex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4Hex) {
    const hi = Number.parseInt(v4Hex[1]!, 16);
    const lo = Number.parseInt(v4Hex[2]!, 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
};

const isPrivateIp = (ip: string): boolean =>
  isIP(ip) === 4 ? isPrivateIpv4(ip) : isPrivateIpv6(ip);

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);

// Validates that a result URL is safe to fetch: http(s) only, no credentials,
// hostname not local, and EVERY resolved address public. DNS is re-resolved by
// fetch afterwards, so a rebinding window remains; combined with the redirect
// re-validation and response caps this bounds exposure for a dev-first app.
export const assertPublicHttpUrl = (rawUrl: string): Effect.Effect<URL, UnsafeUrl> =>
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
      return url;
    }
    const addresses = yield* Effect.tryPromise({
      try: () => lookup(hostname, { all: true }),
      catch: () => new UnsafeUrl({ url: rawUrl, reason: "DNS resolution failed" }),
    });
    if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
      return yield* new UnsafeUrl({ url: rawUrl, reason: "resolves to private address" });
    }
    return url;
  });
