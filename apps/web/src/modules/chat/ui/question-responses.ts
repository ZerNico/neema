import {
  formatQuestionResponse,
  readQuestionResponse,
  readPresentedQuestions,
  readStoredQuestionPresentation,
  type QuestionResponse,
} from "~/modules/tools/ask-user-schema.ts";

export interface ResolvedQuestionResponse {
  callId: string;
  messageId: string;
  response: QuestionResponse;
  /** The connected app that answered, when one did; the reply itself is folded away. */
  originClientName?: string | null;
}

/** Fail visible: only explicit, valid metadata on the immediate raw reply folds into a card. */
export function associateQuestionResponses(
  messages: ReadonlyArray<{
    id: string;
    role: string;
    status: string;
    content: string;
    questionResponse?: unknown;
    steeredIntoMessageId?: string | null;
    originClientName?: string | null;
  }>,
  toolCalls: ReadonlyArray<{
    id: string;
    messageId: string;
    toolName: string;
    status: string;
    arguments: unknown;
    result: unknown;
  }>,
  attachments: ReadonlyArray<{ messageId: string }>,
): { byAssistant: Map<string, ResolvedQuestionResponse>; hiddenMessageIds: Set<string> } {
  const byAssistant = new Map<string, ResolvedQuestionResponse>();
  const hiddenMessageIds = new Set<string>();
  const attached = new Set(attachments.map((item) => item.messageId));
  const presentations = new Map<string, Array<(typeof toolCalls)[number]>>();
  for (const row of toolCalls) {
    if (
      row.toolName !== "ask_user" ||
      row.status !== "complete" ||
      !readPresentedQuestions(row.result)
    )
      continue;
    const list = presentations.get(row.messageId) ?? [];
    list.push(row);
    presentations.set(row.messageId, list);
  }
  // A steer sits just after the answer it went into, so it stands between that
  // answer and a reply to its questions; adjacency is judged without steers.
  const turns = messages.filter((message) => !message.steeredIntoMessageId);
  for (let i = 1; i < turns.length; i++) {
    const answer = turns[i]!;
    const assistant = turns[i - 1]!;
    if (
      answer.role !== "user" ||
      answer.status !== "complete" ||
      attached.has(answer.id) ||
      assistant.role !== "assistant" ||
      assistant.status !== "complete"
    )
      continue;
    const response = readQuestionResponse(answer.questionResponse);
    if (!response) continue;
    const presented = presentations.get(assistant.id) ?? [];
    if (presented.length !== 1) continue;
    const ask = presented[0]!;
    const questions = readStoredQuestionPresentation(ask.arguments, ask.result);
    // Count presented batches before validating args, matching the transaction's
    // ambiguity guard. URL detection here is intentionally conservative.
    if (
      !questions ||
      questions.some((question) =>
        question.options.some((option) => /https?:\/\//i.test(option.label)),
      )
    )
      continue;
    if (formatQuestionResponse(questions, response) !== answer.content) continue;
    byAssistant.set(assistant.id, {
      callId: ask.id,
      messageId: answer.id,
      response,
      ...(answer.originClientName ? { originClientName: answer.originClientName } : {}),
    });
    hiddenMessageIds.add(answer.id);
  }
  return { byAssistant, hiddenMessageIds };
}
