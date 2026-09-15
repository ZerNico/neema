import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { conversationDocuments, conversations } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import { DocumentNotAvailable, type ConversationDocument } from "../schema.ts";

type DocumentRow = typeof conversationDocuments.$inferSelect;
type DocumentWrite = Partial<Pick<DocumentRow, "title" | "content" | "revision" | "lastEditedBy">>;
const toDocument = (row: DocumentRow): ConversationDocument => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class DocumentRepo extends Context.Service<
  DocumentRepo,
  {
    /** Caller holds the conversation lock. */
    create(
      tx: DbTx,
      conversationId: string,
      values: Pick<DocumentRow, "title" | "content" | "lastEditedBy" | "createdByMessageId">,
    ): Effect.Effect<ConversationDocument>;
    get(userId: string, documentId: string): Effect.Effect<ConversationDocument | null>;
    /** Oldest first, so a chat's documents keep the order they were created in. */
    listForConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ConversationDocument[]>;
    /** Always conversation → document; a model fence runs before this acquires either lock. */
    lock(
      tx: DbTx,
      userId: string,
      documentId: string,
    ): Effect.Effect<ConversationDocument, DocumentNotAvailable>;
    /** Caller holds lock; the revision is explicit so CAS stays in the service. */
    write(
      tx: DbTx,
      documentId: string,
      changes: DocumentWrite,
    ): Effect.Effect<ConversationDocument>;
    lockConversation(
      tx: DbTx,
      userId: string,
      conversationId: string,
    ): Effect.Effect<void, DocumentNotAvailable>;
  }
>()("chat/documents/DocumentRepo") {
  static readonly layer = Layer.effect(
    DocumentRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const lockConversation = Effect.fn(function* (
        tx: DbTx,
        userId: string,
        conversationId: string,
      ) {
        const [conversation] = yield* tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
          .for("update")
          .pipe(Effect.orDie);
        if (!conversation) return yield* new DocumentNotAvailable({ conversationId });
      });
      return DocumentRepo.of({
        lockConversation,
        create: Effect.fn("DocumentRepo.create")(function* (tx, conversationId, values) {
          const [row] = yield* tx
            .insert(conversationDocuments)
            .values({ id: uuidv7(), conversationId, ...values })
            .returning()
            .pipe(Effect.orDie);
          return toDocument(row!);
        }),
        get: Effect.fn("DocumentRepo.get")(function* (userId, documentId) {
          const [row] = yield* db
            .select({ document: conversationDocuments })
            .from(conversationDocuments)
            .innerJoin(conversations, eq(conversations.id, conversationDocuments.conversationId))
            .where(and(eq(conversations.userId, userId), eq(conversationDocuments.id, documentId)))
            .pipe(Effect.orDie);
          return row ? toDocument(row.document) : null;
        }),
        listForConversation: Effect.fn("DocumentRepo.listForConversation")(
          function* (userId, conversationId) {
            const rows = yield* db
              .select({ document: conversationDocuments })
              .from(conversationDocuments)
              .innerJoin(conversations, eq(conversations.id, conversationDocuments.conversationId))
              .where(
                and(
                  eq(conversations.userId, userId),
                  eq(conversationDocuments.conversationId, conversationId),
                ),
              )
              .orderBy(asc(conversationDocuments.id))
              .pipe(Effect.orDie);
            return rows.map((row) => toDocument(row.document));
          },
        ),
        lock: Effect.fn("DocumentRepo.lock")(function* (tx, userId, documentId) {
          // Unlocked read only to resolve the parent: the conversation lock is
          // taken first in every path, and the locked re-read below is what the
          // caller acts on.
          const [parent] = yield* tx
            .select({ conversationId: conversationDocuments.conversationId })
            .from(conversationDocuments)
            .where(eq(conversationDocuments.id, documentId))
            .pipe(Effect.orDie);
          if (!parent) return yield* new DocumentNotAvailable({ documentId });
          yield* lockConversation(tx, userId, parent.conversationId);
          const [row] = yield* tx
            .select()
            .from(conversationDocuments)
            .where(eq(conversationDocuments.id, documentId))
            .for("update")
            .pipe(Effect.orDie);
          if (!row) return yield* new DocumentNotAvailable({ documentId });
          return toDocument(row);
        }),
        write: Effect.fn("DocumentRepo.write")(function* (tx, documentId, changes) {
          const [row] = yield* tx
            .update(conversationDocuments)
            .set({ ...changes, updatedAt: new Date() })
            .where(eq(conversationDocuments.id, documentId))
            .returning()
            .pipe(Effect.orDie);
          return toDocument(row!);
        }),
      });
    }),
  );
}
