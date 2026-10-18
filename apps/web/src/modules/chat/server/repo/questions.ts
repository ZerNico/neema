import { and, eq, isNull } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  type AskUserParams,
  QuestionResponse,
  formatQuestionResponse,
  readPresentedQuestions,
  readStoredQuestionPresentation,
} from "~/modules/tools/ask-user-schema.ts";
import { extractUserUrls } from "~/modules/tools/server/user-urls.ts";
import { messages, messageToolCalls } from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { InvalidMessage } from "../../errors.ts";
import type { MessageRow } from "../repo.ts";

// Callers hold the conversation lock. Only one successful immutable batch can
// own the immediately following structured user response.
/**
 * A conversation's turns without the steers inside them. A steer sorts just
 * after the answer it went into, so anything asking "what came last" (the
 * question a reply answers, whether the queue may start) reads through this.
 */
export const turnMessagesOf = (conversationId: string) =>
  and(eq(messages.conversationId, conversationId), isNull(messages.steeredIntoMessageId));

export const questionForMessage = Effect.fn("ChatRepo.questionForMessage")(function* (
  tx: Pick<DbTx, "select">,
  owner: MessageRow | undefined,
) {
  if (owner?.role !== "assistant" || owner.status !== "complete") return null;
  const calls = yield* tx
    .select()
    .from(messageToolCalls)
    .where(
      and(
        eq(messageToolCalls.messageId, owner.id),
        eq(messageToolCalls.toolName, "ask_user"),
        eq(messageToolCalls.status, "complete"),
      ),
    )
    .pipe(Effect.orDie);
  const presented = calls.flatMap((call) => {
    const questions = readPresentedQuestions(call.result);
    return questions ? [{ call, questions }] : [];
  });
  if (presented.length !== 1) return null;
  const batch = presented[0]!;
  if (
    !readStoredQuestionPresentation(batch.call.arguments, batch.call.result) ||
    extractUserUrls(
      batch.questions.flatMap((question) => question.options.map((option) => option.label)),
    ).length > 0
  )
    return null;
  return batch;
});

export const questionContent = (
  questions: AskUserParams["questions"],
  response: QuestionResponse,
) => {
  const decoded = Schema.decodeUnknownOption(QuestionResponse)(response);
  const content = Option.isSome(decoded) ? formatQuestionResponse(questions, decoded.value) : null;
  return content === null || Option.isNone(decoded)
    ? Effect.fail(
        new InvalidMessage({
          reason: "Answer every question with valid selections or custom text.",
        }),
      )
    : Effect.succeed({ content, questionResponse: { v: 1, response: decoded.value } as JsonValue });
};
