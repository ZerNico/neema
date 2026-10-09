import { and, asc, eq, gt, isNotNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  documentComments,
  documents,
  documentSteps,
  projects,
  user,
} from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { projectCan, type ProjectRole } from "~/modules/projects/schema.ts";
import { projectRoleSql } from "~/modules/projects/server/access.ts";
import { Db } from "~/server/db.ts";
import {
  DocumentNotAvailable,
  DocumentRejected,
  type DocumentComment,
  type EditableDocument,
} from "../schema.ts";

type DocumentRow = typeof documents.$inferSelect;
type DocumentWrite = Partial<
  Pick<DocumentRow, "content" | "revision" | "lastEditedBy" | "lastEditorUserId">
>;
type Reader = Pick<DbTx, "select">;

/**
 * The reader's standing on the document in scope: a chat's document is its
 * owner's alone, a project's follows the project role. Null means no access.
 */
const accessSql = (userId: string) => sql<ProjectRole | null>`(case
  when ${documents.conversationId} is not null then (
    select 'owner' from ${conversations}
    where ${conversations.id} = ${documents.conversationId} and ${conversations.userId} = ${userId}
  )
  else (select ${projectRoleSql(userId)} from ${projects} where ${projects.id} = ${documents.projectId})
end)`;
const documentColumns = (userId: string) => ({
  id: documents.id,
  conversationId: documents.conversationId,
  projectId: documents.projectId,
  createdByMessageId: documents.createdByMessageId,
  title: documents.title,
  content: documents.content,
  revision: documents.revision,
  lastEditedBy: documents.lastEditedBy,
  lastEditorUserId: documents.lastEditorUserId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  access: accessSql(userId),
});
type Selected = Omit<DocumentRow, "snapshot" | "snapshotRevision"> & {
  access: ProjectRole | null;
};
const toDocument = ({ access, ...row }: Selected): EditableDocument => ({
  ...row,
  canEdit: projectCan.edit(access),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export interface StoredStep {
  revision: number;
  step: Record<string, unknown>;
  clientId: string;
  generationId: string | null;
  createdAt: Date;
}
export interface StoredDocumentState {
  document: EditableDocument;
  snapshot: Record<string, unknown>;
  snapshotRevision: number;
  steps: StoredStep[];
}
export type DocumentOwner = { conversationId: string } | { projectId: string };

export class DocumentRepo extends Context.Service<
  DocumentRepo,
  {
    /** Caller holds the owner's lock (the conversation's, or the project's row). */
    create(
      tx: DbTx,
      userId: string,
      owner: DocumentOwner,
      values: Pick<DocumentRow, "title" | "content" | "lastEditedBy" | "snapshot"> & {
        createdByMessageId?: string | null;
      },
    ): Effect.Effect<EditableDocument>;
    get(userId: string, documentId: string, tx?: Reader): Effect.Effect<EditableDocument | null>;
    /** Oldest first, so an owner's documents keep the order they were created in. */
    list(userId: string, owner: DocumentOwner): Effect.Effect<EditableDocument[]>;
    /** Snapshot plus every later step, in revision order: enough to rebuild the tree. */
    loadState(userId: string, documentId: string): Effect.Effect<StoredDocumentState | null>;
    /**
     * Locks the document row alone, for someone allowed to edit it. A
     * person's batches arrive several times a second, and the conversation
     * lock would queue them ahead of chat writes; a model write already holds
     * that lock through its fence, taken first.
     */
    lock(
      tx: DbTx,
      userId: string,
      documentId: string,
    ): Effect.Effect<EditableDocument, DocumentNotAvailable | DocumentRejected>;
    appendSteps(
      tx: DbTx,
      rows: ReadonlyArray<
        Pick<
          typeof documentSteps.$inferInsert,
          "documentId" | "revision" | "step" | "clientId" | "origin" | "userId" | "generationId"
        >
      >,
    ): Effect.Effect<void>;
    /** Caller holds the lock; the revision is explicit so ordering stays in the service. */
    write(
      tx: DbTx,
      userId: string,
      documentId: string,
      changes: DocumentWrite,
    ): Effect.Effect<EditableDocument>;
    /** Folds every step up to `revision` into the snapshot. Caller holds the lock. */
    compact(
      tx: DbTx,
      documentId: string,
      snapshot: Record<string, unknown>,
      revision: number,
    ): Effect.Effect<void>;
    /** Deletes a project's document; a chat's goes with its answer instead. */
    remove(tx: DbTx, documentId: string): Effect.Effect<void>;
    lockConversation(
      tx: DbTx,
      userId: string,
      conversationId: string,
    ): Effect.Effect<void, DocumentNotAvailable>;
    /** Oldest first, with each author's name. */
    comments(documentId: string, tx?: Reader): Effect.Effect<DocumentComment[]>;
    /** Caller holds the document's lock. */
    addComment(
      tx: DbTx,
      row: {
        id: string;
        documentId: string;
        threadId: string;
        userId: string | null;
        origin: "user" | "model";
        body: string;
        quote?: string | null;
        toAssistant?: boolean;
      },
    ): Effect.Effect<void>;
    resolveThread(
      tx: DbTx,
      documentId: string,
      threadId: string,
      resolved: boolean,
    ): Effect.Effect<boolean>;
    /** A person's own comment or the assistant's; a thread's first takes its replies with it. */
    deleteComment(
      tx: DbTx,
      documentId: string,
      commentId: string,
      userId: string,
    ): Effect.Effect<boolean>;
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
      const get = Effect.fn("DocumentRepo.get")(function* (
        userId: string,
        documentId: string,
        tx?: Reader,
      ) {
        const access = accessSql(userId);
        const [row] = yield* (tx ?? db)
          .select(documentColumns(userId))
          .from(documents)
          .where(and(eq(documents.id, documentId), isNotNull(access)))
          .pipe(Effect.orDie);
        return row ? toDocument(row) : null;
      });
      return DocumentRepo.of({
        lockConversation,
        create: Effect.fn("DocumentRepo.create")(function* (tx, userId, owner, values) {
          const id = uuidv7();
          yield* tx
            .insert(documents)
            .values({
              id,
              ...("conversationId" in owner
                ? { conversationId: owner.conversationId }
                : { projectId: owner.projectId }),
              title: values.title,
              content: values.content,
              lastEditedBy: values.lastEditedBy,
              lastEditorUserId: userId,
              createdByMessageId: values.createdByMessageId ?? null,
              snapshot: values.snapshot,
              snapshotRevision: 0,
            })
            .pipe(Effect.orDie);
          return (yield* get(userId, id, tx))!;
        }),
        get,
        list: Effect.fn("DocumentRepo.list")(function* (userId, owner) {
          const access = accessSql(userId);
          const rows = yield* db
            .select(documentColumns(userId))
            .from(documents)
            .where(
              and(
                "conversationId" in owner
                  ? eq(documents.conversationId, owner.conversationId)
                  : eq(documents.projectId, owner.projectId),
                isNotNull(access),
              ),
            )
            .orderBy(asc(documents.id))
            .pipe(Effect.orDie);
          return rows.map(toDocument);
        }),
        loadState: Effect.fn("DocumentRepo.loadState")(function* (userId, documentId) {
          // The share lock holds off a compaction between the two reads, which
          // would hand back a snapshot newer than the steps read after it.
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [row] = yield* tx
                  .select({
                    ...documentColumns(userId),
                    snapshot: documents.snapshot,
                    snapshotRevision: documents.snapshotRevision,
                  })
                  .from(documents)
                  .where(and(eq(documents.id, documentId), isNotNull(accessSql(userId))))
                  .for("share", { of: documents })
                  .pipe(Effect.orDie);
                if (!row) return null;
                const { snapshot, snapshotRevision, ...document } = row;
                const steps = yield* tx
                  .select({
                    revision: documentSteps.revision,
                    step: documentSteps.step,
                    clientId: documentSteps.clientId,
                    generationId: documentSteps.generationId,
                    createdAt: documentSteps.createdAt,
                  })
                  .from(documentSteps)
                  .where(
                    and(
                      eq(documentSteps.documentId, documentId),
                      gt(documentSteps.revision, snapshotRevision),
                    ),
                  )
                  .orderBy(asc(documentSteps.revision))
                  .pipe(Effect.orDie);
                return { document: toDocument(document), snapshot, snapshotRevision, steps };
              }),
            )
            .pipe(Effect.orDie);
        }),
        lock: Effect.fn("DocumentRepo.lock")(function* (tx, userId, documentId) {
          const [row] = yield* tx
            .select(documentColumns(userId))
            .from(documents)
            .where(eq(documents.id, documentId))
            .for("update", { of: documents })
            .pipe(Effect.orDie);
          if (!row?.access) return yield* new DocumentNotAvailable({ documentId });
          if (!projectCan.edit(row.access))
            return yield* new DocumentRejected({ reason: "this document is read-only for you" });
          return toDocument(row);
        }),
        appendSteps: Effect.fn("DocumentRepo.appendSteps")(function* (tx, rows) {
          if (rows.length)
            yield* tx
              .insert(documentSteps)
              .values([...rows])
              .pipe(Effect.orDie);
        }),
        write: Effect.fn("DocumentRepo.write")(function* (tx, userId, documentId, changes) {
          yield* tx
            .update(documents)
            .set({ ...changes, updatedAt: new Date() })
            .where(eq(documents.id, documentId))
            .pipe(Effect.orDie);
          return (yield* get(userId, documentId, tx))!;
        }),
        compact: Effect.fn("DocumentRepo.compact")(function* (tx, documentId, snapshot, revision) {
          yield* tx
            .update(documents)
            .set({ snapshot, snapshotRevision: revision })
            .where(eq(documents.id, documentId))
            .pipe(Effect.orDie);
          yield* tx
            .delete(documentSteps)
            .where(
              and(eq(documentSteps.documentId, documentId), lte(documentSteps.revision, revision)),
            )
            .pipe(Effect.orDie);
        }),
        remove: Effect.fn("DocumentRepo.remove")(function* (tx, documentId) {
          yield* tx.delete(documents).where(eq(documents.id, documentId)).pipe(Effect.orDie);
        }),
        comments: Effect.fn("DocumentRepo.comments")(function* (documentId, tx) {
          const rows = yield* (tx ?? db)
            .select({
              id: documentComments.id,
              threadId: documentComments.threadId,
              body: documentComments.body,
              createdAt: documentComments.createdAt,
              resolvedAt: documentComments.resolvedAt,
              origin: documentComments.origin,
              toAssistant: documentComments.toAssistant,
              quote: documentComments.quote,
              authorId: user.id,
              authorName: user.name,
            })
            .from(documentComments)
            .leftJoin(user, eq(user.id, documentComments.userId))
            .where(eq(documentComments.documentId, documentId))
            .orderBy(asc(documentComments.createdAt), asc(documentComments.id))
            .pipe(Effect.orDie);
          return rows.map((row, index): DocumentComment => ({
            id: row.id,
            threadId: row.threadId,
            author: row.authorId ? { id: row.authorId, name: row.authorName ?? "" } : null,
            byAssistant: row.origin === "model",
            body: row.body,
            createdAt: row.createdAt.toISOString(),
            resolvedAt: row.resolvedAt?.toISOString() ?? null,
            quote: row.quote,
            toAssistant: row.toAssistant,
            // Answered by the assistant writing in the thread after it.
            answered:
              row.toAssistant &&
              rows
                .slice(index + 1)
                .some((later) => later.threadId === row.threadId && later.origin === "model"),
          }));
        }),
        addComment: Effect.fn("DocumentRepo.addComment")(function* (tx, row) {
          yield* tx.insert(documentComments).values(row).pipe(Effect.orDie);
        }),
        resolveThread: Effect.fn("DocumentRepo.resolveThread")(
          function* (tx, documentId, threadId, resolved) {
            const updated = yield* tx
              .update(documentComments)
              .set({ resolvedAt: resolved ? new Date() : null })
              .where(
                and(eq(documentComments.documentId, documentId), eq(documentComments.id, threadId)),
              )
              .returning({ id: documentComments.id })
              .pipe(Effect.orDie);
            return updated.length > 0;
          },
        ),
        deleteComment: Effect.fn("DocumentRepo.deleteComment")(
          function* (tx, documentId, commentId, userId) {
            const [own] = yield* tx
              .select({ threadId: documentComments.threadId })
              .from(documentComments)
              .where(
                and(
                  eq(documentComments.documentId, documentId),
                  eq(documentComments.id, commentId),
                  // A person's own, or the assistant's, which has no hand to take its own back.
                  or(eq(documentComments.userId, userId), eq(documentComments.origin, "model")),
                ),
              )
              .pipe(Effect.orDie);
            if (!own) return false;
            yield* tx
              .delete(documentComments)
              .where(
                and(
                  eq(documentComments.documentId, documentId),
                  own.threadId === commentId
                    ? eq(documentComments.threadId, commentId)
                    : eq(documentComments.id, commentId),
                ),
              )
              .pipe(Effect.orDie);
            return true;
          },
        ),
      });
    }),
  );
}
