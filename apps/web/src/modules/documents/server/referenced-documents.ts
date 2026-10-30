import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { conversationDocuments, documents } from "~/db/schema/index.ts";
import { extractReferences } from "~/modules/chat/references.ts";
import type { DbTx } from "~/server/db.ts";

/**
 * Adds the sender's own documents a message names to its chat, under the
 * answer it gets, and keeps them: naming one is choosing it. A document
 * already in the chat keeps its place. Caller holds the turn's transaction.
 */
export const linkReferencedDocuments = (
  tx: DbTx,
  input: { userId: string; conversationId: string; messageId: string; content: string },
) =>
  Effect.gen(function* () {
    const named = extractReferences(input.content)
      .references.filter((reference) => reference.kind === "document")
      .map((reference) => reference.id);
    if (named.length === 0) return;
    const own = yield* tx
      .update(documents)
      .set({ answerMessageId: null })
      .where(and(inArray(documents.id, named), eq(documents.userId, input.userId)))
      .returning({ id: documents.id })
      .pipe(Effect.orDie);
    if (own.length === 0) return;
    yield* tx
      .insert(conversationDocuments)
      .values(
        own.map(({ id }) => ({
          conversationId: input.conversationId,
          documentId: id,
          messageId: input.messageId,
        })),
      )
      .onConflictDoNothing()
      .pipe(Effect.orDie);
  });
