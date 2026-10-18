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
/** The stored set itself while the live answer adds nothing to it. */
const joined = (stored: Set<string>, live: readonly string[]) =>
  live.every((id) => stored.has(id)) ? stored : new Set([...stored, ...live]);

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
  // A draft or document of this conversation, from any of the three paths that can
  // reveal one. References whose owning conversation is not this one are branch copies.
  // The stored rows are scanned only when they change, not on every live chunk.
  const stored = useMemo(() => {
    const found = {
      agent: new Set(data.agentDrafts.map((draft) => draft.id)),
      schedule: new Set((data.scheduleDrafts ?? []).map((draft) => draft.id)),
      document: new Set((data.documents ?? []).map((document) => document.id)),
    };
    for (const row of data.toolCalls) {
      const draft = Schema.is(AgentDraftToolName)(row.toolName)
        ? { target: found.agent, result: projectAgentDraftResult(row.result) }
        : Schema.is(ScheduleDraftToolName)(row.toolName)
          ? { target: found.schedule, result: projectScheduleDraftResult(row.result) }
          : null;
      if (draft?.result.draftId && draft.result.draftConversationId === conversationId)
        draft.target.add(draft.result.draftId);
      if (Schema.is(DocumentToolName)(row.toolName)) {
        const result = projectDocumentResult(row.result);
        if (result.documentId && ownsDocument(result, conversationId, projectId))
          found.document.add(result.documentId);
      }
    }
    return found;
  }, [
    conversationId,
    data.agentDrafts,
    data.documents,
    data.scheduleDrafts,
    data.toolCalls,
    projectId,
  ]);
  const live = useMemo(() => {
    const found = { agent: [] as string[], schedule: [] as string[], document: [] as string[] };
    for (const activity of tools) {
      if (
        (activity.family === "agent-draft" || activity.family === "schedule-draft") &&
        activity.result?.draftId &&
        activity.result.draftConversationId === conversationId
      )
        found[activity.family === "agent-draft" ? "agent" : "schedule"].push(
          activity.result.draftId,
        );
      else if (
        activity.family === "document" &&
        activity.result?.documentId &&
        ownsDocument(activity.result, conversationId, projectId)
      )
        found.document.push(activity.result.documentId);
    }
    return found;
  }, [conversationId, projectId, tools]);
  const discoveredDrafts = useMemo(() => joined(stored.agent, live.agent), [stored, live]);
  const discoveredScheduleDrafts = useMemo(
    () => joined(stored.schedule, live.schedule),
    [stored, live],
  );
  const discoveredDocuments = useMemo(() => joined(stored.document, live.document), [stored, live]);
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
