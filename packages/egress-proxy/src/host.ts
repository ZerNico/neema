import { isIP } from "node:net";
import { dotted, ipv6Words } from "./ip.ts";

export function canonicalHost(
  raw: string,
): { ok: true; host: string; kind: "name" | "ipv4" | "ipv6" } | { ok: false; reason: string } {
  const invalid = { ok: false, reason: "Invalid host spelling" } as const;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 253) return invalid;
  try {
    if (raw.includes(":")) {
      const words = ipv6Words(raw);
      if (!words) return invalid;
      if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
        return { ok: true, host: dotted(words[6], words[7]), kind: "ipv4" };
      }
      return { ok: true, host: new URL(`http://[${raw}]/`).hostname.slice(1, -1), kind: "ipv6" };
    }
    if (/[^A-Za-z0-9._-]/.test(raw)) return invalid;
    const name = raw.toLowerCase().replace(/\.$/, "");
    if (
      name
        .split(".")
        .some(
          (label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"),
        )
    )
      return invalid;
    // WHATWG host parsing recognizes every legacy IPv4 spelling we must guard.
    const host = new URL(`http://${name}/`).hostname;
    if (isIP(host) === 4) return { ok: true, host, kind: "ipv4" };
    if (host !== name) return invalid;
    return { ok: true, host, kind: "name" };
  } catch {
    return invalid;
  }
}

export function parseTarget(raw: string): { host: string; port: number } | undefined {
  const match = raw.startsWith("[")
    ? /^\[([^\]]+)\]:([1-9][0-9]*)$/.exec(raw)
    : /^([^:[\]\s]+):([1-9][0-9]*)$/.exec(raw);
  const [whole, host, portText] = match ?? [];
  if (whole !== raw || host === undefined || portText === undefined) return;
  const port = Number(portText);
  if (port > 65535 || (raw.startsWith("[") && (isIP(host) !== 6 || host.includes("%")))) return;
  return { host, port };
}

/** Authority of an absolute-form `http://` target, for denial reports only. Never used to forward. */
export function plainHttpAuthority(raw: string): { host: string; port: number } | undefined {
  if (!/^http:\/\//i.test(raw)) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  const port = url.port ? Number(url.port) : 80;
  const host = canonicalHost(
    url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
  );
  if (!host.ok || port < 1 || port > 65535) return;
  return { host: host.host, port };
}
