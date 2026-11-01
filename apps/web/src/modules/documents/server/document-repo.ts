import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversationDocuments,
  conversations,
  documentComments,
  documentGroupGrants,
  documentPublicLinks,
  documents,
  documentSteps,
  documentUserGrants,
  documentVersions,
  groupMembers,
  projects,
  user,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import { projectCan, type ProjectRole } from "~/modules/projects/schema.ts";
import { projectRoleSql } from "~/modules/projects/server/access.ts";
import { Db, type DbTx } from "~/server/db.ts";
import {
  DocumentNotAvailable,
  DocumentRejected,
  type DocumentComment,
  type EditableDocument,
  type LibraryDocument,
} from "../schema.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import type { StepAuthor } from "./versions.ts";

type DocumentRow = typeof documents.$inferSelect;
/** A kept version as history lists it. */
export interface Checkpoint {
  revision: number;
  origin: "user" | "model" | null;
  userId: string | null;
  userName: string | null;
  endedAt: Date;
  name: string | null;
}
type DocumentWrite = Partial<
  Pick<DocumentRow, "title" | "revision" | "lastEditedBy" | "lastEditorUserId">
>;
type Reader = Pick<DbTx, "select">;

/** Whether the document in scope is shared with the person, as an editor when `editor`. */
const grantedSql = (userId: string, editor: boolean) => sql`(
  exists (
    select 1 from ${documentUserGrants}
    where ${documentUserGrants.documentId} = ${documents.id}
      and ${documentUserGrants.userId} = ${userId}
      ${editor ? sql`and ${documentUserGrants.role} = 'editor'` : sql``}
  )
  or exists (
    select 1 from ${documentGroupGrants}
    join ${groupMembers} on ${groupMembers.groupId} = ${documentGroupGrants.groupId}
    where ${documentGroupGrants.documentId} = ${documents.id}
      and ${groupMembers.userId} = ${userId}
      ${editor ? sql`and ${documentGroupGrants.role} = 'editor'` : sql``}
  )
)`;
/**
 * The reader's standing on the document in scope: a person's document is its
 * owner's and whoever it is shared with, the highest grant winning; a
 * project's follows the project role. Null means no access, which is also
 * every document while the documents feature is off for them.
 */
export const documentAccessSql = (userId: string) => sql<ProjectRole | null>`(case
  when not (${capabilityAllowedSql(userId, "documents")}) then null
  when ${documents.projectId} is not null then (
    select ${projectRoleSql(userId)} from ${projects} where ${projects.id} = ${documents.projectId}
  )
  when ${documents.userId} = ${userId} then 'owner'
  when ${grantedSql(userId, true)} then 'editor'
  when ${grantedSql(userId, false)} then 'viewer'
end)`;
const accessSql = documentAccessSql;
/**
 * Made in a temporary chat and used nowhere else: no other chat shows it,
 * nobody else has it and it has no public link. Only such a document is left
 * out of the library and goes with that chat.
 */
export const temporaryOnlySql = sql<boolean>`(
  exists (
    select 1 from ${conversations}
    where ${conversations.id} = ${documents.originConversationId} and ${conversations.temporary}
  )
  and not exists (
    select 1 from ${conversationDocuments}
    where ${conversationDocuments.documentId} = ${documents.id}
      and ${conversationDocuments.conversationId} <> ${documents.originConversationId}
  )
  and not exists (
    select 1 from ${documentUserGrants} where ${documentUserGrants.documentId} = ${documents.id}
  )
  and not exists (
    select 1 from ${documentGroupGrants} where ${documentGroupGrants.documentId} = ${documents.id}
  )
  and not exists (
    select 1 from ${documentPublicLinks} where ${documentPublicLinks.documentId} = ${documents.id}
  )
)`;
const documentColumns = (userId: string) => ({
  id: documents.id,
  userId: documents.userId,
  // Another's chat is theirs alone, even by id.
  conversationId: sql<
    string | null
  >`(case when ${documents.userId} = ${userId} then ${documents.originConversationId} end)`,
  projectId: documents.projectId,
  title: documents.title,
  revision: documents.revision,
  lastEditedBy: documents.lastEditedBy,
  lastEditorUserId: documents.lastEditorUserId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  access: accessSql(userId),
});
type Selected = Omit<DocumentRow, "snapshot" | "snapshotRevision" | "originConversationId"> & {
  conversationId: string | null;
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
  userId: string | null;
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
/** A document's place for its images: where it is created, or a person's own once it exists. */
export type ImageOwner = DocumentOwner | { userId: string };

export class DocumentRepo extends Context.Service<
  DocumentRepo,
  {
    /** Caller holds the owner's lock (the conversation's, or the project's row); a person's own needs none. */
    create(
      tx: DbTx,
      userId: string,
      owner: ImageOwner,
      values: Pick<DocumentRow, "title" | "lastEditedBy" | "snapshot"> & {
        /** The answer whose card shows it in its chat. */
        messageId?: string | null;
        /** Given when the snapshot already names the document, as an imported image's address does. */
        id?: string;
      },
    ): Effect.Effect<EditableDocument>;
    get(userId: string, documentId: string, tx?: Reader): Effect.Effect<EditableDocument | null>;
    /**
     * Whose files images in the owner's documents are: the project's owner,
     * the chat's, or the person's. Null unless the caller may edit there; for
     * a person's document the claim's lock checks that.
     */
    imageOwner(userId: string, owner: ImageOwner, tx?: Reader): Effect.Effect<string | null>;
    /** Oldest first, so an owner's documents keep the order they were created in. */
    list(userId: string, owner: DocumentOwner): Effect.Effect<EditableDocument[]>;
    /** The person's own documents they can reach now, last changed first. */
    library(userId: string): Effect.Effect<LibraryDocument[]>;
    /** Snapshot plus every later step, in revision order: enough to rebuild the tree. */
    loadState(userId: string, documentId: string): Effect.Effect<StoredDocumentState | null>;
    /**
     * Who wrote each kept step after `afterRevision`, and when, in revision
     * order: a person by name, the assistant, or no one (the server's own repairs).
     */
    stepAuthors(
      documentId: string,
      afterRevision: number,
      through?: number,
      tx?: DbTx,
    ): Effect.Effect<ReadonlyArray<StepAuthor>>;
    /** The text kept at the end of each folded version, newest first, without the text. */
    checkpoints(documentId: string, tx?: DbTx): Effect.Effect<ReadonlyArray<Checkpoint>>;
    /** One kept version's tree, or null. */
    checkpointAt(
      documentId: string,
      revision: number,
    ): Effect.Effect<Record<string, unknown> | null>;
    /** Keeps each version's text, leaving one already kept at that revision as it is. Caller holds the lock. */
    keepCheckpoints(
      tx: DbTx,
      rows: ReadonlyArray<typeof documentVersions.$inferInsert>,
    ): Effect.Effect<void>;
    /** Names a kept version, or takes its name off with null. Caller holds the lock. */
    nameCheckpoint(
      tx: DbTx,
      documentId: string,
      revision: number,
      name: string | null,
    ): Effect.Effect<void>;
    dropCheckpoints(
      tx: DbTx,
      documentId: string,
      revisions: ReadonlyArray<number>,
    ): Effect.Effect<void>;
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
    remove(tx: DbTx, documentId: string): Effect.Effect<void>;
    lockConversation(
      tx: DbTx,
      userId: string,
      conversationId: string,
    ): Effect.Effect<void, DocumentNotAvailable>;
    /** Oldest first, with each author's name. */
    comments(documentId: string, tx?: Reader): Effect.Effect<DocumentComment[]>;
    /** Hands a person's document to a project. Caller holds the document's lock. */
    moveToProject(tx: DbTx, documentId: string, projectId: string): Effect.Effect<void>;
    /** A person's display name, for the cursor others see. */
    userName(userId: string): Effect.Effect<string>;
    /** Caller holds the document's lock. False when the comment's ID is already taken. */
    addComment(
      tx: DbTx,
      row: {
        id: string;
        documentId: string;
        threadId: string;
        userId: string | null;
        origin: "user" | "model" | "file";
        fileAuthor?: string | null;
        body: string;
        quote?: string | null;
        toAssistant?: boolean;
      },
    ): Effect.Effect<boolean>;
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
          .where(ownedConversationById(conversationId, userId))
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
          const id = values.id ?? uuidv7();
          // The caller holds the chat's lock as its owner, so a chat's document is the caller's.
          yield* tx
            .insert(documents)
            .values({
              id,
              ...("projectId" in owner ? { projectId: owner.projectId } : { userId }),
              ...("conversationId" in owner ? { originConversationId: owner.conversationId } : {}),
              title: values.title,
              lastEditedBy: values.lastEditedBy,
              lastEditorUserId: userId,
              snapshot: values.snapshot,
              snapshotRevision: 0,
            })
            .pipe(Effect.orDie);
          if ("conversationId" in owner)
            yield* tx
              .insert(conversationDocuments)
              .values({
                conversationId: owner.conversationId,
                documentId: id,
                messageId: values.messageId ?? null,
              })
              .pipe(Effect.orDie);
          return (yield* get(userId, id, tx))!;
        }),
        get,
        imageOwner: Effect.fn("DocumentRepo.imageOwner")(function* (userId, owner, tx) {
          if ("userId" in owner) return owner.userId || null;
          if ("conversationId" in owner) {
            const [chat] = yield* (tx ?? db)
              .select({ userId: conversations.userId })
              .from(conversations)
              .where(ownedConversationById(owner.conversationId, userId))
              .pipe(Effect.orDie);
            return chat?.userId ?? null;
          }
          const [project] = yield* (tx ?? db)
            .select({ userId: projects.userId, role: projectRoleSql(userId) })
            .from(projects)
            .where(eq(projects.id, owner.projectId))
            .pipe(Effect.orDie);
          return project && projectCan.edit(project.role) ? project.userId : null;
        }),
        list: Effect.fn("DocumentRepo.list")(function* (userId, owner) {
          const access = accessSql(userId);
          const rows = yield* db
            .select(documentColumns(userId))
            .from(documents)
            .where(
              and(
                "conversationId" in owner
                  ? inArray(
                      documents.id,
                      db
                        .select({ id: conversationDocuments.documentId })
                        .from(conversationDocuments)
                        .where(eq(conversationDocuments.conversationId, owner.conversationId)),
                    )
                  : eq(documents.projectId, owner.projectId),
                isNotNull(access),
              ),
            )
            .orderBy(asc(documents.id))
            .pipe(Effect.orDie);
          return rows.map(toDocument);
        }),
        library: Effect.fn("DocumentRepo.library")(function* (userId) {
          const rows = yield* db
            .select({
              ...documentColumns(userId),
              sharedBy: sql<string | null>`(
                select ${user.name} from ${user}
                where ${user.id} = ${documents.userId} and ${user.id} <> ${userId}
              )`,
              conversationTitle: sql<string | null>`(
                select ${conversations.title} from ${conversations}
                where ${conversations.id} = ${documents.originConversationId}
                  and ${conversations.userId} = ${documents.userId}
                  and ${conversations.deletedAt} is null
              )`,
            })
            .from(documents)
            .where(
              and(
                isNull(documents.projectId),
                sql`not ${temporaryOnlySql}`,
                or(eq(documents.userId, userId), grantedSql(userId, false)),
                isNotNull(accessSql(userId)),
              ),
            )
            .orderBy(desc(documents.updatedAt), desc(documents.id))
            .limit(500)
            .pipe(Effect.orDie);
          return rows.map(({ conversationTitle, sharedBy, ...row }) => ({
            ...toDocument(row),
            // Another's chat is theirs to know about.
            conversationTitle: sharedBy === null ? conversationTitle : null,
            sharedBy,
          }));
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
                    userId: documentSteps.userId,
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
                return {
                  document: toDocument(document),
                  snapshot,
                  snapshotRevision,
                  steps,
                };
              }),
            )
            .pipe(Effect.orDie);
        }),
        stepAuthors: Effect.fn("DocumentRepo.stepAuthors")(
          function* (documentId, afterRevision, through, tx) {
            return yield* (tx ?? db)
              .select({
                revision: documentSteps.revision,
                origin: documentSteps.origin,
                userId: documentSteps.userId,
                userName: user.name,
                createdAt: documentSteps.createdAt,
              })
              .from(documentSteps)
              .leftJoin(user, eq(user.id, documentSteps.userId))
              .where(
                and(
                  eq(documentSteps.documentId, documentId),
                  gt(documentSteps.revision, afterRevision),
                  through === undefined ? undefined : lte(documentSteps.revision, through),
                ),
              )
              .orderBy(asc(documentSteps.revision))
              .pipe(Effect.orDie);
          },
        ),
        checkpoints: Effect.fn("DocumentRepo.checkpoints")(function* (documentId, tx) {
          return yield* (tx ?? db)
            .select({
              revision: documentVersions.revision,
              origin: documentVersions.origin,
              userId: documentVersions.userId,
              userName: user.name,
              endedAt: documentVersions.endedAt,
              name: documentVersions.name,
            })
            .from(documentVersions)
            .leftJoin(user, eq(user.id, documentVersions.userId))
            .where(eq(documentVersions.documentId, documentId))
            .orderBy(desc(documentVersions.revision))
            .pipe(Effect.orDie);
        }),
        checkpointAt: Effect.fn("DocumentRepo.checkpointAt")(function* (documentId, revision) {
          const [row] = yield* db
            .select({ snapshot: documentVersions.snapshot })
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.documentId, documentId),
                eq(documentVersions.revision, revision),
              ),
            )
            .pipe(Effect.orDie);
          return row?.snapshot ?? null;
        }),
        keepCheckpoints: Effect.fn("DocumentRepo.keepCheckpoints")(function* (tx, rows) {
          if (!rows.length) return;
          yield* tx
            .insert(documentVersions)
            .values([...rows])
            .onConflictDoNothing()
            .pipe(Effect.orDie);
        }),
        nameCheckpoint: Effect.fn("DocumentRepo.nameCheckpoint")(
          function* (tx, documentId, revision, name) {
            yield* tx
              .update(documentVersions)
              .set({ name })
              .where(
                and(
                  eq(documentVersions.documentId, documentId),
                  eq(documentVersions.revision, revision),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),
        dropCheckpoints: Effect.fn("DocumentRepo.dropCheckpoints")(
          function* (tx, documentId, revisions) {
            if (!revisions.length) return;
            yield* tx
              .delete(documentVersions)
              .where(
                and(
                  eq(documentVersions.documentId, documentId),
                  inArray(documentVersions.revision, [...revisions]),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),
        lock: Effect.fn("DocumentRepo.lock")(function* (tx, userId, documentId) {
          const [row] = yield* tx
            .select(documentColumns(userId))
            .from(documents)
            .where(eq(documents.id, documentId))
            .for("update", { of: documents })
            .pipe(Effect.orDie);
          if (!row?.access) return yield* new DocumentNotAvailable({ documentId });
          if (!projectCan.edit(row.access))
            return yield* new DocumentRejected({ reason: localized(m.documents_error_read_only) });
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
        moveToProject: Effect.fn("DocumentRepo.moveToProject")(
          function* (tx, documentId, projectId) {
            yield* tx
              .update(documents)
              .set({
                projectId,
                userId: null,
                updatedAt: new Date(),
              })
              .where(eq(documents.id, documentId))
              .pipe(Effect.orDie);
            // A project chat lists the project's documents already; a link would list it twice.
            yield* tx
              .delete(conversationDocuments)
              .where(eq(conversationDocuments.documentId, documentId))
              .pipe(Effect.orDie);
            // The project's members are who reads it now.
            yield* tx
              .delete(documentUserGrants)
              .where(eq(documentUserGrants.documentId, documentId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(documentGroupGrants)
              .where(eq(documentGroupGrants.documentId, documentId))
              .pipe(Effect.orDie);
            yield* tx
              .delete(documentPublicLinks)
              .where(eq(documentPublicLinks.documentId, documentId))
              .pipe(Effect.orDie);
          },
        ),
        userName: Effect.fn("DocumentRepo.userName")(function* (userId) {
          const [row] = yield* db
            .select({ name: user.name })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          return row?.name ?? "Someone";
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
              fileAuthor: documentComments.fileAuthor,
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
            fromFile: row.origin === "file" ? { name: row.fileAuthor ?? "" } : null,
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
          const inserted = yield* tx
            .insert(documentComments)
            .values(row)
            .onConflictDoNothing()
            .returning({ id: documentComments.id })
            .pipe(Effect.orDie);
          return inserted.length > 0;
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
                  // A person's own, or the assistant's or a file's, which no one else can take back.
                  or(
                    eq(documentComments.userId, userId),
                    eq(documentComments.origin, "model"),
                    eq(documentComments.origin, "file"),
                  ),
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
