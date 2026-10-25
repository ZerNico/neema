import { Effect, Stream } from "effect";
import { sessionEnded } from "~/modules/auth/server/account-eligibility.ts";
import { ChatRepo } from "./repo.ts";
import { StreamEngine } from "./streaming.ts";

/**
 * A message's live stream for the person whose chat it is, or null for anyone
 * else, so a guessed message id reads nothing. It ends with the session.
 */
export const openMessageStream = (input: {
  userId: string;
  sessionId: string;
  messageId: string;
  afterSeq: number;
  generationId: string | undefined;
}) =>
  Effect.gen(function* () {
    const repo = yield* ChatRepo;
    const engine = yield* StreamEngine;
    const message = yield* repo.getMessage(input.messageId);
    if (!message) return null;
    yield* repo.getConversation(input.userId, message.conversationId);
    const ended = yield* sessionEnded(input.sessionId, input.userId);
    return engine
      .subscribe(input.messageId, input.afterSeq, input.generationId)
      .pipe(Stream.interruptWhen(ended));
  }).pipe(Effect.catchTag("ConversationNotFound", () => Effect.succeed(null)));
