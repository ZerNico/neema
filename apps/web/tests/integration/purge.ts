import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { conversations } from "~/db/schema/index.ts";
import { deleteMark } from "~/modules/chat/server/owned-conversation.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";

/**
 * Moves a deleted chat past its grace period, so the next sweep purges it.
 * Returns its delete mark as moved, which is what an Undo now has to name.
 */
export const outlastGrace = (conversationId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [row] = yield* db
      .update(conversations)
      .set({ deletedAt: sql`now() - interval '1 day'` })
      .where(eq(conversations.id, conversationId))
      .returning({ mark: deleteMark })
      .pipe(Effect.orDie);
    return row?.mark ?? "";
  });

/**
 * Deletes a chat and purges it at once, as the sweep would after the grace
 * period. Returns the storage keys the caller must delete; none when the chat
 * was not the user's to delete.
 */
export const purgeConversation = (userId: string, conversationId: string) =>
  Effect.gen(function* () {
    const repo = yield* ChatRepo;
    if ((yield* repo.trashConversation(userId, conversationId)) === null) return [];
    yield* outlastGrace(conversationId);
    return (yield* repo.purgeExpired(conversationId))?.keys ?? [];
  });
