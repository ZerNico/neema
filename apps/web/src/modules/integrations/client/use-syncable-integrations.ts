import { useQuery } from "@tanstack/react-query";
import { findIntegration } from "../catalog.ts";
import { myIntegrationsQuery } from "./queries.ts";

/** Connected integrations this person can sync a collection from. */
export function useSyncableIntegrations() {
  const mine = useQuery(myIntegrationsQuery);
  return (mine.data ?? []).filter(
    (integration) =>
      integration.available &&
      integration.connection?.status === "active" &&
      findIntegration(integration.id)?.knowledgeSource,
  );
}
