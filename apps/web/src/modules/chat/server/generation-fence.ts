import { and, eq } from "drizzle-orm";
import { Context, Duration, Effect } from "effect";
import { conversations, messages } from "~/db/schema/chat.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";

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
      .where(
        and(eq(conversations.id, fence.conversationId), eq(conversations.userId, fence.userId)),
      )
      .for("update")
      .pipe(Effect.orDie);
    if (!conversation) return yield* Effect.interrupt;
    const [message] = yield* tx
      .select()
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

/**
 * How often the chat service looks for queues a restart left waiting; `null`
 * turns the sweep off. Tests that assert queue state turn it off rather than
 * racing a background start, or hiding from it in Work chats.
 */
export const QueueSweepInterval = Context.Reference<Duration.Duration | null>(
  "chat/QueueSweepInterval",
  { defaultValue: () => Duration.seconds(5) },
);
