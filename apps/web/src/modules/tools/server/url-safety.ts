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
