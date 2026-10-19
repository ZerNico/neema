import { queryOptions } from "@tanstack/react-query";
import {
  listAdminIntegrations,
  listChatIntegrations,
  listIntegrationScopeOptions,
  listKnowledgeSources,
  listMyIntegrations,
  listPendingIntegrationCalls,
  listPersonalServers,
} from "../server/functions.ts";

export const adminIntegrationsQuery = queryOptions({
  queryKey: ["admin", "integrations"],
  queryFn: () => listAdminIntegrations(),
});

/** The signed-in person's integrations; Settings, the composer and pickers share it. */
export const myIntegrationsQuery = queryOptions({
  queryKey: ["integrations", "mine"],
  queryFn: () => listMyIntegrations(),
});

/** MCP servers this person added; under `integrations` so a change refreshes it. */
export const personalServersQuery = queryOptions({
  queryKey: ["integrations", "personal"],
  queryFn: () => listPersonalServers(),
});

/** Where a browser starts a sign-in (the desktop shell hands it to the system browser): another account, or `connectionId` to reconnect that one. */
export const connectUrl = (
  integrationId: string,
  options: { returnTo?: string; connectionId?: string } = {},
) => {
  const query = new URLSearchParams();
  if (options.returnTo) query.set("returnTo", options.returnTo);
  if (options.connectionId) query.set("account", options.connectionId);
  const search = query.toString();
  return `/api/integrations/${integrationId}/connect${search ? `?${search}` : ""}`;
};

/** A chat's integrations; `null` is the composer of a chat not created yet. */
export const chatIntegrationsQuery = (conversationId: string | null) =>
  queryOptions({
    queryKey: ["integrations", "chat", conversationId],
    queryFn: () => listChatIntegrations({ data: { conversationId } }),
  });

/** Calls waiting on this person; refetched on `integration.approval.changed`. */
export const pendingIntegrationCallsQuery = queryOptions({
  queryKey: ["integration-approvals"],
  queryFn: () => listPendingIntegrationCalls(),
});

/** Under `knowledge` so index and resource refreshes reach it too. */
export const knowledgeSourcesQuery = (collectionId: string) =>
  queryOptions({
    queryKey: ["knowledge", "sources", collectionId],
    queryFn: () => listKnowledgeSources({ data: { collectionId } }),
  });

/** What an account can be limited to; under `integrations` so a reconnect refreshes it. */
export const integrationScopeOptionsQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ["integrations", "scope-options", connectionId],
    queryFn: () => listIntegrationScopeOptions({ data: { connectionId } }),
  });
