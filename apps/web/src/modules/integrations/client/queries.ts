import { queryOptions } from "@tanstack/react-query";
import {
  listAdminIntegrations,
  listChatIntegrations,
  listKnowledgeSources,
  listMyIntegrations,
  listPendingIntegrationCalls,
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

/** Where a browser starts OAuth; the desktop shell hands it to the system browser. */
export const connectUrl = (integrationId: string, returnTo?: string) =>
  `/api/integrations/${integrationId}/connect${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;

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
