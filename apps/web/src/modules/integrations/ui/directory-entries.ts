import type { ComponentProps, ComponentType } from "react";
import type { Localized } from "~/i18n/localized.ts";
import { INTEGRATION_TYPES } from "../catalog.ts";
import { integrationLook } from "../client/directory.ts";
import type { IntegrationCategory } from "../manifest.ts";
import { KNOWN_MCP_SERVERS } from "../mcp/known-servers.ts";

/**
 * One service the add dialogs offer: a type the code ships, a known MCP
 * server, or an integration an admin set up for a person to connect.
 */
export interface DirectoryEntry {
  readonly key: string;
  readonly kind: string;
  readonly server: string | null;
  /** Set when it is an integration already set up, which picking only connects. */
  readonly integrationId: string | null;
  readonly name: string;
  readonly description: Localized;
  /** Null for a server added by address, found under All only. */
  readonly category: IntegrationCategory | null;
  readonly logo: ComponentType<ComponentProps<"svg">>;
}

export const byName = (a: DirectoryEntry, b: DirectoryEntry) => a.name.localeCompare(b.name);

/** An integration an admin set up, offered for a person to connect; null for an unknown type. */
export const integrationEntry = (integration: {
  id: string;
  kind: string;
  server: string | null;
  name: string;
  description: string | null;
}): DirectoryEntry | null => {
  const look = integrationLook(integration);
  return look
    ? {
        key: integration.id,
        kind: integration.kind,
        server: integration.server,
        integrationId: integration.id,
        name: integration.name,
        description: look.description,
        category: look.category,
        logo: look.logo,
      }
    : null;
};

/** The known MCP servers, which a person adds for themselves. */
export const SERVER_ENTRIES: ReadonlyArray<DirectoryEntry> = KNOWN_MCP_SERVERS.map((server) => ({
  key: `mcp:${server.id}`,
  kind: "mcp",
  server: server.id,
  integrationId: null,
  name: server.name,
  description: server.description,
  category: server.category,
  logo: server.logo,
})).toSorted(byName);

/** The types the code ships, which an admin sets up under a name of their own. */
export const TYPE_ENTRIES: ReadonlyArray<DirectoryEntry> = INTEGRATION_TYPES.flatMap((type) =>
  type.category
    ? [
        {
          key: type.kind,
          kind: type.kind,
          server: null,
          integrationId: null,
          name: type.name,
          description: type.description,
          category: type.category,
          logo: type.logo,
        },
      ]
    : [],
).toSorted(byName);

/** A name not in use yet: the entry's own, else numbered. */
export const freeName = (base: string, taken: ReadonlyArray<string>) => {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
};

/** A list short enough to take in at a glance needs no search or categories. */
export const searchable = (entries: ReadonlyArray<DirectoryEntry>) => entries.length > 6;
