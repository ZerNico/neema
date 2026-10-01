import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, relative, sep } from "node:path";
import { domainToASCII } from "node:url";
import type { NetworkGrant } from "@chat/desktop-rpc";
import { serialWrites, writeJsonAtomic } from "./json-file.ts";

export const networkGrantsDirectory = (userData: string) => join(userData, "network-grants");

/** A protected path cannot be changed directly or by replacing an ancestor. */
export const conflictsWithNetworkGrants = (directory: string, path: string) => {
  const inside = (parent: string, child: string) => {
    const rest = relative(parent, child);
    return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !rest.startsWith(sep));
  };
  return inside(directory, path) || inside(path, directory);
};

export const normalizeNetworkGrant = (host: string): NetworkGrant | null => {
  if (typeof host !== "string" || host.length > 253) return null;
  const value = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!/^[\x21-\x7e]+$/.test(value)) return null;
  const ascii = domainToASCII(value).toLowerCase();
  if (ascii !== value.toLowerCase() || ascii.length > 253 || isIP(ascii)) return null;
  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) ||
    ["localhost", "local", "internal", "lan"].includes(labels.at(-1)!) ||
    ascii.endsWith(".home.arpa") ||
    /^\d+$/.test(ascii)
  )
    return null;
  return { host: ascii };
};

export interface NetworkGrants {
  readonly directory: string;
  list(): readonly NetworkGrant[];
  has(grant: NetworkGrant): boolean;
  add(grant: NetworkGrant): Promise<void>;
  remove(grant: NetworkGrant): Promise<void>;
}

export const loadNetworkGrants = async (directory: string): Promise<NetworkGrants> => {
  const file = join(directory, "approved.json");
  let hosts = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry !== "string") continue;
        const grant = normalizeNetworkGrant(entry);
        if (grant && entry === grant.host) hosts.add(grant.host);
      }
    }
  } catch {
    // A lost or invalid file restores the default allowlist, never a broader one.
  }
  const queue = serialWrites();
  const change = (grant: NetworkGrant, add: boolean) => {
    const valid = normalizeNetworkGrant(grant.host);
    if (!valid || valid.host !== grant.host)
      return Promise.reject(new Error("Invalid network grant."));
    return queue(async () => {
      if (add === hosts.has(grant.host)) return;
      const updated = new Set(hosts);
      if (add) updated.add(grant.host);
      else updated.delete(grant.host);
      await writeJsonAtomic(file, [...updated]);
      hosts = updated;
    });
  };
  return {
    directory,
    list: () => [...hosts].sort().map((host) => ({ host })),
    has: (grant) => hosts.has(grant.host),
    add: (grant) => change(grant, true),
    remove: (grant) => change(grant, false),
  };
};
