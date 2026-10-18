import { canonicalHost } from "./host.ts";
import { carriedIPv4, ipv6Words } from "./ip.ts";

/** The one refusal a grant can lift, by opting its host into private-network addresses. */
export const PRIVATE_NETWORK = "private network";

const metadata4 = new Set(["100.100.100.200", "168.63.129.16", "192.0.0.192"]);
const metadata6 = new Set([
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
  "fd00:42::42",
  "fd00:a9fe:a9fe::1",
  "fd00:100::100:200",
]);

function checkedInterfaces(addresses: ReadonlyArray<string>): string[] {
  return addresses.map((address) => {
    const result = canonicalHost(address);
    if (!result.ok || result.kind === "name") throw new Error("Invalid interface address");
    return result.host;
  });
}

function identities(address: string): string[] {
  const words = ipv6Words(address);
  const carried = words && carriedIPv4(words);
  return carried ? [address, carried] : [address];
}

function ipv4Refusal(address: string, privateNetwork: boolean): string | null {
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return "invalid address";
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified / this-network";
  if (a === 169 && b === 254) return "link-local";
  if (a >= 224 && a <= 239) return "multicast";
  if (address === "255.255.255.255") return "broadcast";
  if (a >= 240) return "reserved";
  if (metadata4.has(address)) return "cloud metadata / platform endpoint";
  // Only the /24 is special; the rest of 192.0/16 is public (WordPress.com serves from it).
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (
    !privateNetwork &&
    (a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      // Benchmarking networks, which labs and some appliances use privately.
      (a === 198 && (b === 18 || b === 19)))
  )
    return PRIVATE_NETWORK;
  return null;
}

/** Normalizes the interface list once per enumeration. Throws on an invalid entry. */
export function interfaceIdentities(addresses: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(checkedInterfaces(addresses).flatMap(identities));
}

export function addressRefusal(
  address: string,
  ownInterfaces: ReadonlyArray<string>,
  privateNetwork: boolean,
): string | null {
  if (typeof address !== "string") return "invalid address";
  const candidate = canonicalHost(address);
  if (!candidate.ok || candidate.kind === "name") return "invalid address";
  let own: ReadonlySet<string>;
  try {
    own = interfaceIdentities(ownInterfaces);
  } catch {
    return "interface list invalid";
  }
  return preparedRefusal(address, own, privateNetwork);
}

export function preparedRefusal(
  address: string,
  own: ReadonlySet<string>,
  privateNetwork: boolean,
): string | null {
  const candidate = canonicalHost(address);
  if (!candidate.ok || candidate.kind === "name") return "invalid address";
  if (identities(candidate.host).some((identity) => own.has(identity))) return "host interface";
  if (candidate.kind === "ipv4") return ipv4Refusal(candidate.host, privateNetwork);
  const words = ipv6Words(candidate.host);
  if (!words) return "invalid address";
  if (candidate.host === "::") return "unspecified / this-network";
  if (candidate.host === "::1") return "loopback";
  if ((words[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((words[0] & 0xff00) === 0xff00) return "multicast";
  if ((words[0] === 0xfd00 && words[1] === 0xec2) || metadata6.has(candidate.host))
    return "cloud metadata / platform endpoint";
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return "local-use NAT64";
  if (!privateNetwork && (words[0] & 0xfe00) === 0xfc00) return PRIVATE_NETWORK;
  const carried = carriedIPv4(words);
  return carried ? ipv4Refusal(carried, privateNetwork) : null;
}
