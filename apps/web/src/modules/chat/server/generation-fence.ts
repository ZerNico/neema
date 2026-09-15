import { and, eq } from "drizzle-orm";
import { Context, Effect } from "effect";
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
    if (!message || message.role !== "assistant")
      return yield* Effect.interrupt;
    return message;
  });
