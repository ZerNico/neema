import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { conversationDocuments, documents } from "~/db/schema/index.ts";
import { extractReferences } from "~/modules/chat/references.ts";
import type { DbTx } from "~/server/db.ts";
import { documentAccessSql } from "./document-repo.ts";

/**
 * Adds the documents a message names to its chat, under the answer it gets:
 * the sender's own and any shared with them. A document already in the chat
 * keeps its place. Caller holds the turn's transaction.
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
    const readable = yield* tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          inArray(documents.id, named),
          isNull(documents.projectId),
          isNotNull(documentAccessSql(input.userId)),
        ),
      )
      .pipe(Effect.orDie);
    if (readable.length === 0) return;
    yield* tx
      .insert(conversationDocuments)
      .values(
        readable.map(({ id }) => ({
          conversationId: input.conversationId,
          documentId: id,
          messageId: input.messageId,
        })),
      )
      .onConflictDoNothing()
      .pipe(Effect.orDie);
  });
