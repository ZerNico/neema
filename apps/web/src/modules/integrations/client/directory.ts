import { queryOptions, useQuery } from "@tanstack/react-query";
import { findIntegrationType } from "../catalog.ts";
import type { IntegrationManifest } from "../manifest.ts";
import type { IntegrationDirectoryEntry } from "../schema.ts";
import { listIntegrationDirectory } from "../server/functions.ts";

/** Under `integrations`, so `integrations.changed` refreshes it with the rest. */
export const integrationDirectoryQuery = queryOptions({
  queryKey: ["integrations", "directory"],
  queryFn: () => listIntegrationDirectory(),
  staleTime: 5 * 60_000,
});

export type KnownIntegration = IntegrationDirectoryEntry & { manifest: IntegrationManifest };

/**
 * Every integration set up on this server, by id: what a stored reference (a
 * tool row, a citation, a grant) needs to be named and drawn. An id it does
 * not know, deleted since or not loaded yet, reads as the id itself.
 */
export function useIntegrationDirectory() {
  const { data } = useQuery(integrationDirectoryQuery);
  const known: KnownIntegration[] = [];
  for (const entry of data ?? []) {
    const manifest = findIntegrationType(entry.kind);
    if (manifest) known.push({ ...entry, manifest });
  }
  const find = (id: string) => known.find((entry) => entry.id === id) ?? null;
  return { list: known, find, name: (id: string) => find(id)?.name ?? id };
}

/** One integration by id, or null while unknown. */
export const useIntegration = (id: string) => useIntegrationDirectory().find(id);
