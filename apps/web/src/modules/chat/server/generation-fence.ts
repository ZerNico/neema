import { and, eq } from "drizzle-orm";
import { Context, Duration, Effect } from "effect";
import { conversations, messages } from "~/db/schema/chat.ts";
import type { DbTx } from "~/server/db.ts";

export interface GenerationIdentity {
  userId: string;
  conversationId: string;
  messageId: string;
  generationId: string;
}
/** Request-local identity inherited by tool and compaction fibers, never global mutable state. */
export const GenerationFence = Context.Reference<GenerationIdentity | null>(
  "chat/GenerationFence",
  { defaultValue: () => null },
);
/**
 * Called once a generation reaches a terminal status, inside the fiber that ran
 * it. The stream engine cannot depend on the chat service, so the service hands
 * this in: it is how a finished answer releases the next queued message.
 */
export const GenerationSettled = Context.Reference<
  (input: {
    userId: string;
    conversationId: string;
    messageId: string;
    status: "complete" | "error" | "aborted";
  }) => Effect.Effect<void>
>("chat/GenerationSettled", { defaultValue: () => () => Effect.void });

export const lockGeneration = (tx: DbTx, fence: GenerationIdentity) =>
  Effect.gen(function* () {
    const [conversation] = yield* tx
      .select({ id: conversations.id })
      .from(conversations)
      // Ownership only, not the deleted mark: a delete stops the answer as
      // Stop does, and an attempt still finishing must settle, not strand.
      .where(
        and(eq(conversations.id, fence.conversationId), eq(conversations.userId, fence.userId)),
      )
      .for("update")
      .pipe(Effect.orDie);
    if (!conversation) return yield* Effect.interrupt;
    // The fence only: this runs on every flush, and the row's JSONB is large.
    const [message] = yield* tx
      .select({ id: messages.id, role: messages.role })
      .from(messages)
      .where(
        and(
          eq(messages.id, fence.messageId),
          eq(messages.conversationId, fence.conversationId),
          eq(messages.generationId, fence.generationId),
          eq(messages.status, "streaming"),
        ),
      )
      .pipe(Effect.orDie);
    if (!message || message.role !== "assistant") return yield* Effect.interrupt;
    return message;
  });

/** `lockGeneration`, then the answer's stored output, for a write that adds to it. */
export const lockGenerationOutput = (tx: DbTx, fence: GenerationIdentity) =>
  Effect.gen(function* () {
    yield* lockGeneration(tx, fence);
    const [row] = yield* tx
      .select({ assistantOutput: messages.assistantOutput })
      .from(messages)
      .where(eq(messages.id, fence.messageId))
      .pipe(Effect.orDie);
    return row?.assistantOutput ?? null;
  });

/**
 * The fence for writes made many times a second (a streamed document edit).
 * It shares the message row with Stop, retry and the reaper, which update it,
 * but never takes the conversation lock: at that rate it would queue ahead of
 * the chat writes it has to stay out of the way of.
 */
export const ensureGenerationLive = (tx: DbTx, fence: GenerationIdentity) =>
  Effect.gen(function* () {
    const [message] = yield* tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, fence.messageId),
          eq(messages.conversationId, fence.conversationId),
          eq(messages.generationId, fence.generationId),
          eq(messages.status, "streaming"),
        ),
      )
      .for("share")
      .pipe(Effect.orDie);
    if (!message) return yield* Effect.interrupt;
  });

/**
 * How often the chat service looks for queues a restart left waiting; `null`
 * turns the sweep off. Tests that assert queue state turn it off rather than
 * racing a background start, or hiding from it in Work chats.
 */
export const QueueSweepInterval = Context.Reference<Duration.Duration | null>(
  "chat/QueueSweepInterval",
  { defaultValue: () => Duration.seconds(5) },
);

/**
 * How often deleted chats past their grace period and expired temporary chats
 * are purged; `null` turns the sweep off. Tests call
 * `ChatService.sweepExpired` directly instead.
 */
export const ConversationSweepInterval = Context.Reference<Duration.Duration | null>(
  "chat/ConversationSweepInterval",
  { defaultValue: () => Duration.minutes(1) },
);
