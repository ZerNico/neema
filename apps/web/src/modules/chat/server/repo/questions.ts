import { and, eq, isNull, type SQL } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  type AskUserParams,
  QuestionResponse,
  type StoredQuestionResponse,
  formatQuestionResponse,
  readPresentedQuestions,
  readStoredQuestionPresentation,
} from "~/modules/tools/ask-user-schema.ts";
import { extractUserUrls } from "~/modules/tools/server/user-urls.ts";
import { messages, messageToolCalls } from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { InvalidMessage } from "../../errors.ts";
import type { MessageRow } from "../repo.ts";
import type { DbTx } from "~/server/db.ts";

// Callers hold the conversation lock. Only one successful immutable batch can
// own the immediately following structured user response.
/**
 * A conversation's turns without the steers inside them. A steer sorts just
 * after the answer it went into, so anything asking "what came last" (the
 * question a reply answers, whether the queue may start) reads through this.
 */
export const turnMessagesOf = (conversationId: string) =>
  and(eq(messages.conversationId, conversationId), isNull(messages.steeredIntoMessageId));

/**
 * An `ask_user` call a person can answer: it presented one readable batch whose
 * options name no web address, which an answer would otherwise grant the model.
 */
const answerable = (call: typeof messageToolCalls.$inferSelect) => {
  const questions = readPresentedQuestions(call.result);
  if (
    !questions ||
    !readStoredQuestionPresentation(call.arguments, call.result) ||
    extractUserUrls(questions.flatMap((question) => question.options.map((option) => option.label)))
      .length > 0
  )
    return null;
  return { call, questions };
};

const askCalls = (tx: Pick<DbTx, "select">, where: SQL | undefined) =>
  tx
    .select()
    .from(messageToolCalls)
    .where(
      and(
        where,
        eq(messageToolCalls.toolName, "ask_user"),
        eq(messageToolCalls.status, "complete"),
      ),
    )
    .pipe(Effect.orDie);

/** The batch a finished answer asked, when it asked exactly one. */
export const questionForMessage = Effect.fn("ChatRepo.questionForMessage")(function* (
  tx: Pick<DbTx, "select">,
  owner: MessageRow | undefined,
) {
  if (owner?.role !== "assistant" || owner.status !== "complete") return null;
  const presented = (yield* askCalls(tx, eq(messageToolCalls.messageId, owner.id))).filter((call) =>
    readPresentedQuestions(call.result),
  );
  return presented.length === 1 ? answerable(presented[0]!) : null;
});

/** The batch a stored answer names, while it can still be answered. */
export const questionByCall = Effect.fn("ChatRepo.questionByCall")(function* (
  tx: Pick<DbTx, "select">,
  callId: string,
) {
  const [call] = yield* askCalls(tx, eq(messageToolCalls.id, callId));
  return call ? answerable(call) : null;
});

const stored = (callId: string, response: QuestionResponse): JsonValue => {
  const value: StoredQuestionResponse = { v: 1, callId, response };
  return value as JsonValue;
};

export const questionContent = (
  batch: { call: { id: string }; questions: AskUserParams["questions"] },
  response: QuestionResponse,
) => {
  const decoded = Schema.decodeUnknownOption(QuestionResponse)(response);
  const content = Option.isSome(decoded)
    ? formatQuestionResponse(batch.questions, decoded.value)
    : null;
  return content === null || Option.isNone(decoded)
    ? Effect.fail(
        new InvalidMessage({
          reason: "Answer every question with valid selections or custom text.",
        }),
      )
    : Effect.succeed({ content, questionResponse: stored(batch.call.id, decoded.value) });
};
