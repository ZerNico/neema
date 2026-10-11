import { Schema } from "effect";
import { useMemo } from "react";
import { AgentDraftToolName, projectAgentDraftResult } from "~/modules/agents/tool-schema.ts";
import { DocumentToolName, projectDocumentResult } from "~/modules/documents/tool-schema.ts";
import {
  ScheduleDraftToolName,
  projectScheduleDraftResult,
} from "~/modules/schedules/tool-schema.ts";
import type { ToolActivity } from "../client/use-message-stream.ts";
import type { getConversationWithMessages } from "../server/functions.ts";

interface DocumentOwnerFields {
  documentId?: string;
  documentConversationId?: string;
  documentProjectId?: string;
}
/** A tool row's document is live here when this chat or its current project owns it. */
export const ownsDocument = (
  result: DocumentOwnerFields,
  conversationId: string,
  projectId: string | null,
) =>
  result.documentConversationId === conversationId ||
  (projectId !== null && result.documentProjectId === projectId);

/**
 * The drafts and documents this chat has, from what the page loaded, the tool
 * rows and the answer streaming now, and which of them that answer just made.
 */
export function useDiscoveredArtifacts({
  data,
  conversationId,
  projectId,
  tools,
  streamingId,
  isMobile,
}: {
  data: Awaited<ReturnType<typeof getConversationWithMessages>>;
  conversationId: string;
  /** The chat's project while the person may still use it, whose documents count too. */
  projectId: string | null;
  /** The streaming answer's tool activity. */
  tools: readonly ToolActivity[];
  streamingId: string | undefined;
  isMobile: boolean;
}) {
  // A draft of this conversation, from any of the three paths that can reveal
  // one. References whose owning conversation is not this one are branch copies.
  const discoveredDrafts = useMemo(() => {
    const ids = new Set(data.agentDrafts.map((draft) => draft.id));
    const mine = (result: { draftId?: string; draftConversationId?: string }) => {
      if (result.draftId && result.draftConversationId === conversationId) ids.add(result.draftId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(AgentDraftToolName)(row.toolName)) mine(projectAgentDraftResult(row.result));
    for (const activity of tools)
      if (activity.family === "agent-draft" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.agentDrafts, data.toolCalls, tools]);
  const discoveredScheduleDrafts = useMemo(() => {
    const ids = new Set((data.scheduleDrafts ?? []).map((draft) => draft.id));
    const mine = (result: { draftId?: string; draftConversationId?: string }) => {
      if (result.draftId && result.draftConversationId === conversationId) ids.add(result.draftId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(ScheduleDraftToolName)(row.toolName))
        mine(projectScheduleDraftResult(row.result));
    for (const activity of tools)
      if (activity.family === "schedule-draft" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.scheduleDrafts, data.toolCalls, tools]);
  const discoveredDocuments = useMemo(() => {
    const ids = new Set((data.documents ?? []).map((document) => document.id));
    const mine = (result: DocumentOwnerFields) => {
      if (result.documentId && ownsDocument(result, conversationId, projectId))
        ids.add(result.documentId);
    };
    for (const row of data.toolCalls)
      if (Schema.is(DocumentToolName)(row.toolName)) mine(projectDocumentResult(row.result));
    for (const activity of tools)
      if (activity.family === "document" && activity.result) mine(activity.result);
    return ids;
  }, [conversationId, data.documents, data.toolCalls, projectId, tools]);
  // What the answer being watched just created, as opposed to what the page
  // loaded with: only these open their panel by themselves. A phone shows the
  // panel as a sheet over the answer, so it never opens one on its own there.
  const liveCreated = useMemo(() => {
    const loaded = new Set([
      ...data.agentDrafts.map((draft) => draft.id),
      ...(data.scheduleDrafts ?? []).map((draft) => draft.id),
      ...(data.documents ?? []).map((document) => document.id),
    ]);
    const fresh = {
      agent: new Set<string>(),
      schedule: new Set<string>(),
      document: new Set<string>(),
    };
    if (isMobile) return fresh;
    const add = (target: Set<string>, id: string | undefined, owner: string | undefined) => {
      if (id && owner === conversationId && !loaded.has(id)) target.add(id);
    };
    // A streamed creation makes the document before its call returns, so the
    // detail already lists it; one the answer streaming now made still opens.
    const writing = streamingId;
    if (writing)
      for (const document of data.documents ?? [])
        if (document.messageId === writing) fresh.document.add(document.id);
    for (const activity of tools) {
      if (activity.family === "agent-draft" && activity.result)
        add(fresh.agent, activity.result.draftId, activity.result.draftConversationId);
      else if (activity.family === "schedule-draft" && activity.result)
        add(fresh.schedule, activity.result.draftId, activity.result.draftConversationId);
      else if (
        activity.family === "document" &&
        activity.result &&
        ownsDocument(activity.result, conversationId, projectId)
      )
        add(fresh.document, activity.result.documentId, conversationId);
    }
    return fresh;
  }, [
    conversationId,
    data.agentDrafts,
    data.documents,
    data.scheduleDrafts,
    isMobile,
    projectId,
    tools,
    streamingId,
  ]);
  return { discoveredDrafts, discoveredScheduleDrafts, discoveredDocuments, liveCreated };
}
