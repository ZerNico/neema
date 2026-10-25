import { readQuestionResponse, type QuestionResponse } from "~/modules/tools/ask-user-schema.ts";

export interface ResolvedQuestionResponse {
  callId: string;
  messageId: string;
  response: QuestionResponse;
  /** The connected app that answered, when one did; the reply itself is folded away. */
  originClientName?: string | null;
}

/**
 * Folds each answer into the question card it names. The server checked the
 * answer against its batch when it was written, so the call id is all it takes.
 */
export function associateQuestionResponses(
  messages: ReadonlyArray<{
    id: string;
    role: string;
    status: string;
    questionResponse?: unknown;
    originClientName?: string | null;
  }>,
  toolCalls: ReadonlyArray<{ id: string; messageId: string; toolName: string }>,
): { byAssistant: Map<string, ResolvedQuestionResponse>; hiddenMessageIds: Set<string> } {
  const byAssistant = new Map<string, ResolvedQuestionResponse>();
  const hiddenMessageIds = new Set<string>();
  const asks = new Map(
    toolCalls.flatMap((call) => (call.toolName === "ask_user" ? [[call.id, call] as const] : [])),
  );
  for (const answer of messages) {
    if (answer.role !== "user" || answer.status !== "complete") continue;
    const stored = readQuestionResponse(answer.questionResponse);
    const ask = stored ? asks.get(stored.callId) : undefined;
    if (!stored || !ask) continue;
    byAssistant.set(ask.messageId, {
      callId: stored.callId,
      messageId: answer.id,
      response: stored.response,
      ...(answer.originClientName ? { originClientName: answer.originClientName } : {}),
    });
    hiddenMessageIds.add(answer.id);
  }
  return { byAssistant, hiddenMessageIds };
}
