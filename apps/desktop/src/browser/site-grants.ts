import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDomain, getHostname } from "tldts";

/**
 * The site a grant covers: the registrable domain, so mail.google.com and
 * accounts.google.com are one approval. A bare host without one (localhost, an
 * address on the network) stands for itself. Null for anything not http(s).
 */
export function siteOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = getHostname(parsed.href);
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

type Store = {
  /** Sites allowed in every Work chat, per server origin. */
  always: Record<string, string[]>;
  /** Sites allowed in one chat, per server origin and conversation. */
  chats: Record<string, Record<string, string[]>>;
};

const empty = (): Store => ({ always: {}, chats: {} });

const isSiteList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((site) => typeof site === "string");

const parse = (text: string): Store => {
  const raw: unknown = JSON.parse(text);
  const store = empty();
  if (typeof raw !== "object" || raw === null) return store;
  const { always, chats } = raw as Record<string, unknown>;
  if (typeof always === "object" && always !== null)
    for (const [origin, sites] of Object.entries(always))
      if (isSiteList(sites)) store.always[origin] = sites;
  if (typeof chats === "object" && chats !== null)
    for (const [origin, byChat] of Object.entries(chats)) {
      if (typeof byChat !== "object" || byChat === null) continue;
      store.chats[origin] = {};
      for (const [conversationId, sites] of Object.entries(byChat))
        if (isSiteList(sites)) store.chats[origin][conversationId] = sites;
    }
  return store;
};

export interface SiteGrants {
  allowed(origin: string, conversationId: string, url: string): boolean;
  allow(
    origin: string,
    conversationId: string,
    url: string,
    scope: "chat" | "always",
  ): Promise<void>;
  always(origin: string): string[];
  revoke(origin: string, site: string): Promise<void>;
}

/**
 * Where the agent may browse without asking, kept on this machine like folder
 * and network grants: the server never learns which sites a person trusts.
 * Written by atomic rename, one change at a time, so concurrent grants cannot
 * resurrect a revoked site. A lost or unreadable file grants nothing.
 */
export async function loadSiteGrants(directory: string): Promise<SiteGrants> {
  const file = join(directory, "browser-sites.json");
  let store = empty();
  try {
    store = parse(await readFile(file, "utf8"));
  } catch {
    // Nothing allowed yet, or a damaged file: either way, everything asks.
  }
  let writes = Promise.resolve();
  const save = (change: (current: Store) => Store) => {
    const next = writes.then(async () => {
      const updated = change(structuredClone(store));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.browser-sites-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(updated), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      store = updated;
    });
    writes = next.catch(() => {});
    return next;
  };
  return {
    allowed: (origin, conversationId, url) => {
      const site = siteOf(url);
      if (!site) return false;
      return (
        (store.always[origin] ?? []).includes(site) ||
        (store.chats[origin]?.[conversationId] ?? []).includes(site)
      );
    },
    allow: (origin, conversationId, url, scope) => {
      const site = siteOf(url);
      if (!site) return Promise.reject(new Error("Not a web address."));
      return save((current) => {
        if (scope === "always") {
          const sites = new Set(current.always[origin] ?? []).add(site);
          current.always[origin] = [...sites];
        } else {
          const chats = (current.chats[origin] ??= {});
          chats[conversationId] = [...new Set(chats[conversationId] ?? []).add(site)];
        }
        return current;
      });
    },
    always: (origin) => [...(store.always[origin] ?? [])].toSorted(),
    revoke: (origin, site) =>
      save((current) => {
        current.always[origin] = (current.always[origin] ?? []).filter((entry) => entry !== site);
        return current;
      }),
  };
}
