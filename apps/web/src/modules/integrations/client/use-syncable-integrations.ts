import { useQuery } from "@tanstack/react-query";
import { findIntegrationType } from "../catalog.ts";
import { myIntegrationsQuery } from "./queries.ts";

/** Integrations this person can sync a collection from, with their working accounts. */
export function useSyncableIntegrations() {
  const mine = useQuery(myIntegrationsQuery);
  return (mine.data ?? []).flatMap((integration) => {
    const accounts = integration.connections.filter((account) => account.status === "active");
    return integration.available &&
      accounts.length &&
      findIntegrationType(integration.kind)?.knowledgeSource
      ? [{ ...integration, connections: accounts }]
      : [];
  });
}
