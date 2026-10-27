import { useMemo } from "react";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import type { SavedUiState } from "~/modules/genui/ui/context.ts";
import type { CompactionActivity, ToolActivity } from "../client/use-message-stream.ts";
import type { getConversationWithMessages } from "../server/functions.ts";
import type { AssistantSteer } from "./assistant-body.ts";
import { timedActivity, toCompactionActivity } from "./stored-activities.ts";

/** A conversation's loaded messages and their rows, as the chat shows them. */
type ConversationRows = Awaited<ReturnType<typeof getConversationWithMessages>>;

/**
 * The conversation's rows grouped by the message they belong to, once per query
 * result: the display map runs on every stream chunk and must not rescan the flat lists.
 */
export function useMessageRows(data: ConversationRows) {
  // What of its agent each answer ran without, keyed by the answer itself.
  const agentUnavailableByMessage = useMemo(
    () =>
      new Map(
        (data.generations ?? []).flatMap((row) =>
          row.agentUnavailable?.length ? [[row.messageId, row.agentUnavailable] as const] : [],
        ),
      ),
    [data.generations],
  );
  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageAttachment[]>();
    for (const attachment of data.attachments) {
      const list = grouped.get(attachment.messageId);
      if (list) list.push(attachment);
      else grouped.set(attachment.messageId, [attachment]);
    }
    return grouped;
  }, [data.attachments]);

  // A steer belongs to the answer it was delivered into and is drawn inside
  // it, so it never becomes a transcript row of its own.
  const steersByAnswer = useMemo(() => {
    const grouped = new Map<string, AssistantSteer[]>();
    for (const message of data.messages) {
      if (!message.steeredIntoMessageId) continue;
      const list = grouped.get(message.steeredIntoMessageId) ?? [];
      list.push({
        id: message.id,
        content: message.content,
        // Rows from before positions were recorded read as arriving first.
        textOffset: message.steerTextOffset ?? 0,
        turnIndex: message.steerTurnIndex ?? -1,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      });
      grouped.set(message.steeredIntoMessageId, list);
    }
    return grouped;
  }, [attachmentsByMessage, data.messages]);

  // Grouped once per query result, since the display map below runs on every
  // stream chunk and must not rescan the flat list per message.
  const uiStatesByMessage = useMemo(() => {
    const grouped = new Map<string, Map<number, SavedUiState>>();
    for (const row of data.uiStates) {
      const states = grouped.get(row.messageId) ?? new Map<number, SavedUiState>();
      states.set(row.ordinal, {
        sourceHash: row.sourceHash,
        state: JSON.stringify(row.state),
        digest: row.digest ?? null,
      });
      grouped.set(row.messageId, states);
    }
    return grouped;
  }, [data.uiStates]);

  const toolCallsByMessage = useMemo(() => {
    const grouped = new Map<string, ToolActivity[]>();
    for (const row of data.toolCalls) {
      const activity = timedActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.toolCalls]);

  const compactionsByMessage = useMemo(() => {
    const grouped = new Map<string, CompactionActivity[]>();
    for (const row of data.compactionEvents) {
      const activity = toCompactionActivity(row);
      const list = grouped.get(row.messageId);
      if (list) list.push(activity);
      else grouped.set(row.messageId, [activity]);
    }
    return grouped;
  }, [data.compactionEvents]);

  // messageId -> id of the next assistant message after it, in one pass.
  const nextAssistantAfter = useMemo(() => {
    const next = new Map<string, string>();
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const message = data.messages[i]!;
      const following = data.messages[i + 1];
      const inherited = following ? next.get(following.id) : undefined;
      const value = following?.role === "assistant" ? following.id : inherited;
      if (value !== undefined) next.set(message.id, value);
    }
    return next;
  }, [data.messages]);

  // Which model wrote each answer, null once its row is gone. The retry menu
  // marks it, and a retry that omits a model reuses it server-side.
  const modelByMessage = useMemo(
    () => new Map(data.messages.map((m) => [m.id, m.modelId])),
    [data.messages],
  );

  // Collections belong to the turn that added them: the user message directly
  // before each answer. That is where the composer showed them, so that is
  // where they stay.
  const collectionsByUserMessage = useMemo(() => {
    const byAssistant = new Map(
      (data.generations ?? []).map((row) => [row.messageId, row.collectionIds] as const),
    );
    const result = new Map<string, ReadonlyArray<string>>();
    let previousUser: string | null = null;
    for (const message of data.messages) {
      if (message.role === "user") previousUser = message.id;
      else if (message.role === "assistant" && previousUser) {
        const ids = byAssistant.get(message.id);
        if (ids && ids.length > 0) result.set(previousUser, ids);
      }
    }
    return result;
  }, [data.generations, data.messages]);
  const skillsByUserMessage = useMemo(() => {
    const byAssistant = new Map(
      (data.generations ?? []).map((row) => [row.messageId, row.skills ?? []] as const),
    );
    const result = new Map<string, ReadonlyArray<{ id: string; name: string }>>();
    let previousUser: string | null = null;
    for (const message of data.messages) {
      if (message.role === "user") previousUser = message.id;
      else if (message.role === "assistant" && previousUser) {
        const skills = byAssistant.get(message.id);
        if (skills?.length) result.set(previousUser, skills);
      }
    }
    return result;
  }, [data.generations, data.messages]);
  return {
    agentUnavailableByMessage,
    attachmentsByMessage,
    steersByAnswer,
    uiStatesByMessage,
    toolCallsByMessage,
    compactionsByMessage,
    nextAssistantAfter,
    modelByMessage,
    collectionsByUserMessage,
    skillsByUserMessage,
  };
}
