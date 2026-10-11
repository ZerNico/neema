import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import {
  attachmentBlobs,
  attachments,
  blobCleanupIntents,
  conversationQueueEntries,
  conversationQueueEntryAttachments,
  conversationWorkingFiles,
  conversations,
  documentImages,
  messageAttachments,
  messages,
} from "~/db/schema/index.ts";
import { attachmentKind } from "../constants.ts";
import type { Attachment, MessageAttachment, QueuedAttachment } from "../schema.ts";
import { AttachmentNotAvailable, AttachmentRejected } from "../errors.ts";
import { collectOrphanedBlobs, lockBlobs } from "./blob-references.ts";
import { isUniqueViolation } from "~/server/sql.ts";

export interface AttachmentAssociation {
  /** May refuse with a rejection; the upload then never stores bytes for this row. */
  before(tx: DbTx): Effect.Effect<void, AttachmentRejected>;
  after(tx: DbTx, attachment: Attachment): Effect.Effect<void>;
}

export type AttachmentRow = typeof attachments.$inferSelect;
export type AttachmentBlobRow = typeof attachmentBlobs.$inferSelect;

/** The transaction handle `Db.transaction` hands its callback. */
export type DbTx = Parameters<Parameters<Db["Service"]["transaction"]>[0]>[0];

/** Attachment joined with its blob, everything the prompt builder needs. */
export interface AttachmentWithBlob {
  id: string;
  userId: string;
  fileName: string;
  blobId: string;
  storageKey: string;
  sha256: string;
  size: number;
  mediaType: string;
  parsedText: string | null;
  parsedWith: string | null;
}

export const toAttachmentDto = (row: {
  id: string;
  fileName: string;
  size: number;
  mediaType: string;
}): Attachment => ({
  id: row.id,
  fileName: row.fileName,
  size: row.size,
  mediaType: row.mediaType,
  kind: attachmentKind(row.mediaType),
});

const withBlobColumns = {
  id: attachments.id,
  userId: attachments.userId,
  fileName: attachments.fileName,
  blobId: attachmentBlobs.id,
  storageKey: attachmentBlobs.storageKey,
  sha256: attachmentBlobs.sha256,
  size: attachmentBlobs.size,
  mediaType: attachmentBlobs.mediaType,
  parsedText: attachmentBlobs.parsedText,
  parsedWith: attachmentBlobs.parsedWith,
};

// Postgres unique_violation, wherever the driver buried it in the cause
// chain. Anything else raised during the claim insert is a real fault and
// must not be dressed up as a user-level conflict.

/**
 * No owner of any kind: not a transcript message's file, a queued message's,
 * a kept working file's or a document's image. Every "is this upload still
 * free" question reads this, so an owned file is never swept, deleted as
 * abandoned, or claimed a second time. Once an owner row cascades away with
 * its chat, answer or document, the sweep takes the attachment and its bytes.
 */
const unclaimed = sql`not exists (select 1 from ${messageAttachments} where ${messageAttachments.attachmentId} = ${attachments.id}) and not exists (select 1 from ${conversationQueueEntryAttachments} where ${conversationQueueEntryAttachments.attachmentId} = ${attachments.id}) and not exists (select 1 from ${conversationWorkingFiles} where ${conversationWorkingFiles.attachmentId} = ${attachments.id}) and not exists (select 1 from ${documentImages} where ${documentImages.attachmentId} = ${attachments.id})`;

/** Whose files these are: a transcript message, or a queued message. */
type AttachmentOwner = { kind: "message"; id: string } | { kind: "queue"; id: string };

const linksOf = (tx: DbTx, owner: AttachmentOwner) =>
  owner.kind === "message"
    ? tx
        .select({ attachmentId: messageAttachments.attachmentId })
        .from(messageAttachments)
        .where(eq(messageAttachments.messageId, owner.id))
        .orderBy(asc(messageAttachments.position))
    : tx
        .select({ attachmentId: conversationQueueEntryAttachments.attachmentId })
        .from(conversationQueueEntryAttachments)
        .where(eq(conversationQueueEntryAttachments.queueEntryId, owner.id))
        .orderBy(asc(conversationQueueEntryAttachments.position));

const dropLinks = (tx: DbTx, owner: AttachmentOwner) =>
  owner.kind === "message"
    ? tx.delete(messageAttachments).where(eq(messageAttachments.messageId, owner.id))
    : tx
        .delete(conversationQueueEntryAttachments)
        .where(eq(conversationQueueEntryAttachments.queueEntryId, owner.id));

const insertLinks = (tx: DbTx, owner: AttachmentOwner, attachmentIds: ReadonlyArray<string>) =>
  owner.kind === "message"
    ? tx.insert(messageAttachments).values(
        attachmentIds.map((attachmentId, position) => ({
          messageId: owner.id,
          attachmentId,
          position,
        })),
      )
    : tx.insert(conversationQueueEntryAttachments).values(
        attachmentIds.map((attachmentId, position) => ({
          queueEntryId: owner.id,
          attachmentId,
          position,
        })),
      );

const lockAttachmentBlobs = (tx: DbTx, attachmentIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (attachmentIds.length === 0) return;
    const rows = yield* tx
      .select({ blobId: attachments.blobId })
      .from(attachments)
      .where(inArray(attachments.id, [...attachmentIds]));
    yield* lockBlobs(
      tx,
      rows.map((row) => row.blobId),
    );
  });

/** Returns the storage keys to delete after commit. */
const deleteAttachmentRows = (
  tx: DbTx,
  attachmentIds: ReadonlyArray<string>,
  onlyUnclaimed = false,
) =>
  Effect.gen(function* () {
    if (attachmentIds.length === 0) return [] as string[];
    const rows = yield* tx
      .select({ blobId: attachments.blobId })
      .from(attachments)
      .where(inArray(attachments.id, [...attachmentIds]));
    const blobIds = [...new Set(rows.map((row) => row.blobId))];
    yield* lockBlobs(tx, blobIds);
    yield* tx
      .delete(attachments)
      .where(
        and(inArray(attachments.id, [...attachmentIds]), onlyUnclaimed ? unclaimed : undefined),
      );
    return yield* collectOrphanedBlobs(tx, blobIds);
  });

export class AttachmentRepo extends Context.Service<
  AttachmentRepo,
  {
    /**
     * Records an upload. The blob is deduped per user (same bytes twice = one
     * blob), the attachment row is always fresh so the response cannot reveal
     * that the user had uploaded these bytes before.
     */
    create(input: {
      association?: AttachmentAssociation;
      userId: string;
      sha256: string;
      storageKey: string;
      size: number;
      mediaType: string;
      fileName: string;
    }): Effect.Effect<{
      attachment: Attachment;
      deduped: boolean;
      unusedStorageKey: string | null;
    }>;
    /** Blob row for a (user, sha256) pair, or null. */
    findBlob(userId: string, sha256: string): Effect.Effect<AttachmentBlobRow | null>;
    /** Attachment + blob + who (if anyone) has claimed it, for policy checks. */
    findForAccess(attachmentId: string): Effect.Effect<{
      attachment: AttachmentWithBlob;
      claimedByMessageId: string | null;
      conversationUserId: string | null;
    } | null>;
    /** Deletes an unclaimed attachment; returns storage keys to remove. */
    deleteUnclaimed(
      userId: string,
      attachmentId: string,
    ): Effect.Effect<ReadonlyArray<string>, AttachmentNotAvailable>;
    /**
     * Points a message at exactly `attachmentIds`, in order, inside the
     * caller's transaction. Returns storage keys for attachments the message
     * dropped, to be deleted after the commit.
     */
    reconcile(
      tx: DbTx,
      input: { userId: string; messageId: string; attachmentIds: ReadonlyArray<string> },
    ): Effect.Effect<ReadonlyArray<string>, AttachmentNotAvailable>;
    /** `reconcile` for a queued message, which holds files until it becomes one. */
    reconcileQueueEntry(
      tx: DbTx,
      input: { userId: string; queueEntryId: string; attachmentIds: ReadonlyArray<string> },
    ): Effect.Effect<ReadonlyArray<string>, AttachmentNotAvailable>;
    /**
     * Moves a queued message's files onto the message it just became, keeping
     * their order. The rows and bytes stay; only the owner changes, so this
     * never produces cleanup work.
     */
    transferQueueEntry(
      tx: DbTx,
      input: { queueEntryId: string; messageId: string },
    ): Effect.Effect<void>;
    /** Releases every file held by these queued messages (removal, deletion). */
    releaseForQueueEntries(
      tx: DbTx,
      queueEntryIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>>;
    listForQueueEntries(
      queueEntryIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<QueuedAttachment>>;
    /**
     * Copies the attachments of each source message onto its target message,
     * inside the caller's transaction (branching). Blobs are shared, not
     * duplicated; only the attachment rows and links are new.
     */
    cloneForMessages(
      tx: DbTx,
      input: {
        userId: string;
        messages: ReadonlyArray<{ sourceMessageId: string; targetMessageId: string }>;
      },
    ): Effect.Effect<ReadonlyMap<string, string>>;
    /**
     * Releases every attachment these messages own (rewind, retry, delete):
     * their message attachments and the working files they kept.
     */
    releaseForMessages(
      tx: DbTx,
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>>;
    /** Releases kept working-file revisions whose row no longer claims them. */
    releaseWorkingFiles(
      tx: DbTx,
      attachmentIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>>;
    /** Flat conversation projection, mirroring how tool calls are shipped. */
    listForMessages(
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<MessageAttachment>>;
    /** Public file-reference metadata, including messages outside the loaded window. */
    listForConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<Attachment>>;
    /** Ordered attachments of these messages, with blob details, for prompting. */
    listWithBlobsForMessages(
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<AttachmentWithBlob & { messageId: string; position: number }>>;
    /** Attachments by id (upload-time capability validation). */
    listWithBlobsByIds(
      userId: string,
      attachmentIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<AttachmentWithBlob>>;
    cacheParsedText(input: {
      blobId: string;
      text: string;
      parsedWith: string;
    }): Effect.Effect<void>;
    /** The blob's scanned pages already read by `engine`, by page number. */
    scannedPages(input: { blobId: string; engine: string }): Effect.Effect<Record<number, string>>;
    /** Adds pages `engine` read; pages another engine read are dropped. */
    saveScannedPages(input: {
      blobId: string;
      engine: string;
      pages: Record<number, string>;
    }): Effect.Effect<void>;
    /**
     * Gives a document one of this person's free image uploads. False, and
     * nothing written, for anything else: someone else's, already owned, not
     * an image, or unknown all answer alike.
     */
    claimForDocument(
      tx: DbTx,
      input: { userId: string; documentId: string; attachmentId: string },
    ): Effect.Effect<boolean>;
    /** A document's claimed image with its blob; null when the document holds no such image. */
    findDocumentImage(
      documentId: string,
      attachmentId: string,
    ): Effect.Effect<AttachmentWithBlob | null>;
    /** Unclaimed uploads older than the cutoff (tab closed before sending). */
    sweepUnclaimed(olderThan: Date): Effect.Effect<ReadonlyArray<string>>;
    /**
     * Records that bytes are about to be written for a key no row owns yet.
     * Written before the store call, so a crash in between is still recoverable.
     */
    recordBlobCandidate(storageKey: string): Effect.Effect<void>;
    /** Drops a resolved intent once its bytes are registered or deleted. */
    clearBlobIntents(storageKeys: ReadonlyArray<string>): Effect.Effect<void>;
    /**
     * Claims due cleanup intents. `orphan` keys are deleted outright;
     * `candidate` keys are only returned once nothing owns them, because the
     * registration that wrote them may have committed after the caller failed.
     * Claiming backs the row off so a failing store cannot spin.
     */
    claimBlobCleanup(input: {
      limit: number;
      candidateCutoff: Date;
      retryAfter: Date;
    }): Effect.Effect<ReadonlyArray<string>>;
  }
>()("chat/attachments/AttachmentRepo") {
  static readonly layer = Layer.effect(
    AttachmentRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      const selectBlob = (tx: DbTx | typeof db, userId: string, sha256: string) =>
        tx
          .select()
          .from(attachmentBlobs)
          .where(and(eq(attachmentBlobs.userId, userId), eq(attachmentBlobs.sha256, sha256)));

      const create = Effect.fn("AttachmentRepo.create")(function* (input: {
        association?: AttachmentAssociation;
        userId: string;
        sha256: string;
        storageKey: string;
        size: number;
        mediaType: string;
        fileName: string;
      }) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (input.association) yield* input.association.before(tx);
              const id = uuidv7();
              // Upsert locks the winning incarnation until its new reference
              // commits; selecting then inserting would race last-ref deletion.
              const [blob] = yield* tx
                .insert(attachmentBlobs)
                .values({
                  id,
                  userId: input.userId,
                  sha256: input.sha256,
                  storageKey: input.storageKey,
                  size: input.size,
                  mediaType: input.mediaType,
                })
                .onConflictDoUpdate({
                  target: [attachmentBlobs.userId, attachmentBlobs.sha256],
                  set: { id: sql`${attachmentBlobs.id}` },
                })
                .returning();
              if (!blob) return yield* Effect.die("blob upsert returned no row");
              const rows = yield* tx
                .insert(attachments)
                .values({
                  id: uuidv7(),
                  userId: input.userId,
                  blobId: blob.id,
                  fileName: input.fileName,
                })
                .returning();
              const row = rows[0]!;
              if (input.association)
                yield* input.association.after(
                  tx,
                  toAttachmentDto({
                    id: row.id,
                    fileName: row.fileName,
                    size: blob.size,
                    mediaType: blob.mediaType,
                  }),
                );
              return {
                attachment: toAttachmentDto({
                  id: row.id,
                  fileName: row.fileName,
                  size: blob.size,
                  mediaType: blob.mediaType,
                }),
                deduped: blob.id !== id,
                unusedStorageKey: blob.storageKey === input.storageKey ? null : input.storageKey,
              };
            }),
          )
          .pipe(Effect.orDie);
      });

      const findBlob = Effect.fn("AttachmentRepo.findBlob")(function* (
        userId: string,
        sha256: string,
      ) {
        const rows = yield* selectBlob(db, userId, sha256).pipe(Effect.orDie);
        return rows[0] ?? null;
      });

      const findForAccess = Effect.fn("AttachmentRepo.findForAccess")(function* (
        attachmentId: string,
      ) {
        const queuedConversations = alias(conversations, "queued_conversations");
        const rows = yield* db
          .select({
            ...withBlobColumns,
            claimedByMessageId: messageAttachments.messageId,
            conversationUserId: conversations.userId,
            // A queued file is shown in the queue strip before it is a
            // message's, so its conversation's owner may read it too.
            queuedConversationUserId: queuedConversations.userId,
          })
          .from(attachments)
          .innerJoin(attachmentBlobs, eq(attachments.blobId, attachmentBlobs.id))
          .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
          .leftJoin(messages, eq(messages.id, messageAttachments.messageId))
          .leftJoin(conversations, eq(conversations.id, messages.conversationId))
          .leftJoin(
            conversationQueueEntryAttachments,
            eq(conversationQueueEntryAttachments.attachmentId, attachments.id),
          )
          .leftJoin(
            conversationQueueEntries,
            eq(conversationQueueEntries.id, conversationQueueEntryAttachments.queueEntryId),
          )
          .leftJoin(
            queuedConversations,
            eq(queuedConversations.id, conversationQueueEntries.conversationId),
          )
          .where(eq(attachments.id, attachmentId))
          .pipe(Effect.orDie);
        const row = rows[0];
        if (!row) return null;
        const { claimedByMessageId, conversationUserId, queuedConversationUserId, ...attachment } =
          row;
        return {
          attachment,
          claimedByMessageId,
          conversationUserId: conversationUserId ?? queuedConversationUserId,
        };
      });

      const deleteUnclaimed = Effect.fn("AttachmentRepo.deleteUnclaimed")(function* (
        userId: string,
        attachmentId: string,
      ) {
        const keys = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Ownership and claim state are checked in the same statement:
              // a claimed or foreign attachment simply matches nothing.
              const rows = yield* tx
                .select({ id: attachments.id })
                .from(attachments)
                .where(
                  and(eq(attachments.id, attachmentId), eq(attachments.userId, userId), unclaimed),
                );
              if (rows.length === 0) return null;
              return yield* deleteAttachmentRows(tx, [attachmentId], true);
            }),
          )
          .pipe(Effect.orDie);
        if (keys === null) return yield* new AttachmentNotAvailable({ attachmentId });
        return keys;
      });

      /**
       * Points one owner at exactly `attachmentIds`, in order. Blob rows are
       * locked before any claim is checked: two owner tables share no unique
       * index, so that lock is what stops one upload being claimed by a message
       * and a queued message at once. Returns cleanup keys for dropped files.
       */
      const claimAttachments = Effect.fn("AttachmentRepo.claimAttachments")(function* (
        tx: DbTx,
        input: { userId: string; owner: AttachmentOwner; attachmentIds: ReadonlyArray<string> },
      ) {
        const requested = input.attachmentIds;
        if (new Set(requested).size !== requested.length) {
          return yield* new AttachmentNotAvailable({ attachmentId: requested[0] ?? "" });
        }

        const previous = (yield* linksOf(tx, input.owner).pipe(Effect.orDie)).map(
          (row) => row.attachmentId,
        );
        const affected = [...new Set([...previous, ...requested])];
        if (affected.length > 0) {
          const rows = yield* tx
            .select({ blobId: attachments.blobId })
            .from(attachments)
            .where(and(inArray(attachments.id, affected), eq(attachments.userId, input.userId)))
            .pipe(Effect.orDie);
          yield* lockBlobs(
            tx,
            rows.map((row) => row.blobId),
          ).pipe(Effect.orDie);
        }

        // Drop every link first so a reorder cannot trip the (owner,
        // position) or (attachment) unique indexes mid-flight.
        if (previous.length > 0) yield* dropLinks(tx, input.owner).pipe(Effect.orDie);

        if (requested.length > 0) {
          // Anything still linked at this point belongs to another owner.
          const usable = yield* tx
            .select({ id: attachments.id })
            .from(attachments)
            .where(
              and(
                inArray(attachments.id, [...requested]),
                eq(attachments.userId, input.userId),
                unclaimed,
              ),
            )
            .pipe(Effect.orDie);
          const usableIds = new Set(usable.map((row) => row.id));
          const missing = requested.find((id) => !usableIds.has(id));
          if (missing !== undefined) {
            return yield* new AttachmentNotAvailable({ attachmentId: missing });
          }

          yield* insertLinks(tx, input.owner, requested).pipe(
            // Within one owner table the unique index still backs the lock up.
            // Only that violation is a user-level conflict; anything else
            // stays a defect.
            Effect.catchTag("EffectDrizzleQueryError", (error) =>
              isUniqueViolation(error)
                ? Effect.fail(new AttachmentNotAvailable({ attachmentId: requested[0]! }))
                : Effect.die(error),
            ),
          );
        }

        const dropped = previous.filter((id) => !requested.includes(id));
        return yield* deleteAttachmentRows(tx, dropped).pipe(Effect.orDie);
      });

      const reconcile = (
        tx: DbTx,
        input: { userId: string; messageId: string; attachmentIds: ReadonlyArray<string> },
      ) =>
        claimAttachments(tx, {
          userId: input.userId,
          owner: { kind: "message", id: input.messageId },
          attachmentIds: input.attachmentIds,
        });

      const reconcileQueueEntry = (
        tx: DbTx,
        input: { userId: string; queueEntryId: string; attachmentIds: ReadonlyArray<string> },
      ) =>
        claimAttachments(tx, {
          userId: input.userId,
          owner: { kind: "queue", id: input.queueEntryId },
          attachmentIds: input.attachmentIds,
        });

      const transferQueueEntry = Effect.fn("AttachmentRepo.transferQueueEntry")(function* (
        tx: DbTx,
        input: { queueEntryId: string; messageId: string },
      ) {
        const owner: AttachmentOwner = { kind: "queue", id: input.queueEntryId };
        const held = (yield* linksOf(tx, owner).pipe(Effect.orDie)).map((row) => row.attachmentId);
        if (held.length === 0) return;
        // Same lock as every claim, so no claim can observe the moment between
        // leaving the queue table and arriving on the message.
        yield* lockAttachmentBlobs(tx, held).pipe(Effect.orDie);
        yield* dropLinks(tx, owner).pipe(Effect.orDie);
        yield* insertLinks(tx, { kind: "message", id: input.messageId }, held).pipe(Effect.orDie);
      });

      const releaseForQueueEntries = Effect.fn("AttachmentRepo.releaseForQueueEntries")(function* (
        tx: DbTx,
        queueEntryIds: ReadonlyArray<string>,
      ) {
        if (queueEntryIds.length === 0) return [] as ReadonlyArray<string>;
        const linked = yield* tx
          .select({ attachmentId: conversationQueueEntryAttachments.attachmentId })
          .from(conversationQueueEntryAttachments)
          .where(inArray(conversationQueueEntryAttachments.queueEntryId, [...queueEntryIds]))
          .pipe(Effect.orDie);
        return yield* deleteAttachmentRows(
          tx,
          linked.map((row) => row.attachmentId),
        ).pipe(Effect.orDie);
      });

      const listForQueueEntries = Effect.fn("AttachmentRepo.listForQueueEntries")(function* (
        queueEntryIds: ReadonlyArray<string>,
      ) {
        if (queueEntryIds.length === 0) return [] as ReadonlyArray<QueuedAttachment>;
        const rows = yield* db
          .select({
            id: attachments.id,
            fileName: attachments.fileName,
            size: attachmentBlobs.size,
            mediaType: attachmentBlobs.mediaType,
            queueEntryId: conversationQueueEntryAttachments.queueEntryId,
            position: conversationQueueEntryAttachments.position,
          })
          .from(conversationQueueEntryAttachments)
          .innerJoin(
            attachments,
            eq(attachments.id, conversationQueueEntryAttachments.attachmentId),
          )
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(inArray(conversationQueueEntryAttachments.queueEntryId, [...queueEntryIds]))
          .orderBy(
            asc(conversationQueueEntryAttachments.queueEntryId),
            asc(conversationQueueEntryAttachments.position),
          )
          .pipe(Effect.orDie);
        return rows.map((row) => ({
          ...toAttachmentDto(row),
          queueEntryId: row.queueEntryId,
          position: row.position,
        }));
      });

      const cloneForMessages = Effect.fn("AttachmentRepo.cloneForMessages")(function* (
        tx: DbTx,
        input: {
          userId: string;
          messages: ReadonlyArray<{ sourceMessageId: string; targetMessageId: string }>;
        },
      ) {
        if (input.messages.length === 0) return new Map<string, string>();
        const targetOf = new Map(
          input.messages.map((m) => [m.sourceMessageId, m.targetMessageId] as const),
        );
        const linked = yield* tx
          .select({
            attachmentId: attachments.id,
            messageId: messageAttachments.messageId,
            position: messageAttachments.position,
            kind: messageAttachments.kind,
            blobId: attachments.blobId,
            fileName: attachments.fileName,
          })
          .from(messageAttachments)
          .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
          .where(
            and(
              inArray(messageAttachments.messageId, [...targetOf.keys()]),
              // Ownership belongs on the copy too: the caller owns the
              // conversation, so anything else here would be a bug worth
              // dropping rather than duplicating.
              eq(attachments.userId, input.userId),
            ),
          )
          .pipe(Effect.orDie);
        if (linked.length === 0) return new Map<string, string>();
        yield* lockBlobs(
          tx,
          linked.map((row) => row.blobId),
        ).pipe(Effect.orDie);

        // Fresh attachment rows are not an option but a requirement:
        // message_attachments.attachment_id is unique, so a row can only ever
        // be claimed by one message. The blob underneath is shared and
        // reference-counted by deleteAttachmentRows.
        const rows = linked.map((row) => ({
          id: uuidv7(),
          userId: input.userId,
          blobId: row.blobId,
          fileName: row.fileName,
          messageId: targetOf.get(row.messageId)!,
          position: row.position,
          kind: row.kind,
        }));

        yield* tx
          .insert(attachments)
          .values(
            rows.map(({ id, userId, blobId, fileName }) => ({ id, userId, blobId, fileName })),
          )
          .pipe(Effect.orDie);
        yield* tx
          .insert(messageAttachments)
          .values(
            rows.map((row) => ({
              messageId: row.messageId,
              attachmentId: row.id,
              position: row.position,
              kind: row.kind,
            })),
          )
          .pipe(Effect.orDie);
        return new Map(linked.map((row, index) => [row.attachmentId, rows[index]!.id]));
      });

      const releaseForMessages = Effect.fn("AttachmentRepo.releaseForMessages")(function* (
        tx: DbTx,
        messageIds: ReadonlyArray<string>,
      ) {
        if (messageIds.length === 0) return [] as ReadonlyArray<string>;
        const linked = yield* tx
          .select({ attachmentId: messageAttachments.attachmentId })
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, [...messageIds]))
          .pipe(Effect.orDie);
        // A retried answer keeps its row, so its kept files are deleted here
        // rather than left to the message cascade.
        const kept = yield* tx
          .delete(conversationWorkingFiles)
          .where(inArray(conversationWorkingFiles.messageId, [...messageIds]))
          .returning({ attachmentId: conversationWorkingFiles.attachmentId })
          .pipe(Effect.orDie);
        return yield* deleteAttachmentRows(tx, [
          ...linked.map((row) => row.attachmentId),
          ...kept.flatMap((row) => (row.attachmentId ? [row.attachmentId] : [])),
        ]).pipe(Effect.orDie);
      });

      const releaseWorkingFiles = Effect.fn("AttachmentRepo.releaseWorkingFiles")(function* (
        tx: DbTx,
        attachmentIds: ReadonlyArray<string>,
      ) {
        return yield* deleteAttachmentRows(tx, attachmentIds).pipe(Effect.orDie);
      });

      const listForMessages = Effect.fn("AttachmentRepo.listForMessages")(function* (
        messageIds: ReadonlyArray<string>,
      ) {
        if (messageIds.length === 0) return [] as ReadonlyArray<MessageAttachment>;
        const rows = yield* db
          .select({
            id: attachments.id,
            fileName: attachments.fileName,
            size: attachmentBlobs.size,
            mediaType: attachmentBlobs.mediaType,
            messageId: messageAttachments.messageId,
            position: messageAttachments.position,
          })
          .from(messageAttachments)
          .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(
            and(
              inArray(messageAttachments.messageId, [...messageIds]),
              eq(messageAttachments.kind, "file"),
            ),
          )
          .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
          .pipe(Effect.orDie);
        return rows.map((row) => ({
          ...toAttachmentDto(row),
          messageId: row.messageId,
          position: row.position,
        }));
      });

      const listForConversation = Effect.fn("AttachmentRepo.listForConversation")(function* (
        userId: string,
        conversationId: string,
      ) {
        const rows = yield* db
          .select({
            id: attachments.id,
            fileName: attachments.fileName,
            size: attachmentBlobs.size,
            mediaType: attachmentBlobs.mediaType,
          })
          .from(messageAttachments)
          .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, userId),
              eq(attachments.userId, userId),
              eq(messageAttachments.kind, "file"),
            ),
          )
          .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
          .pipe(Effect.orDie);
        return rows.map(toAttachmentDto);
      });

      const listWithBlobsForMessages = Effect.fn("AttachmentRepo.listWithBlobsForMessages")(
        function* (messageIds: ReadonlyArray<string>) {
          if (messageIds.length === 0) {
            return [] as ReadonlyArray<
              AttachmentWithBlob & { messageId: string; position: number }
            >;
          }
          return yield* db
            .select({
              ...withBlobColumns,
              messageId: messageAttachments.messageId,
              position: messageAttachments.position,
            })
            .from(messageAttachments)
            .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
            .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
            .where(
              and(
                inArray(messageAttachments.messageId, [...messageIds]),
                eq(messageAttachments.kind, "file"),
              ),
            )
            .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
            .pipe(Effect.orDie);
        },
      );

      const listWithBlobsByIds = Effect.fn("AttachmentRepo.listWithBlobsByIds")(function* (
        userId: string,
        attachmentIds: ReadonlyArray<string>,
      ) {
        if (attachmentIds.length === 0) return [] as ReadonlyArray<AttachmentWithBlob>;
        return yield* db
          .select(withBlobColumns)
          .from(attachments)
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(and(inArray(attachments.id, [...attachmentIds]), eq(attachments.userId, userId)))
          .pipe(Effect.orDie);
      });

      const cacheParsedText = Effect.fn("AttachmentRepo.cacheParsedText")(function* (input: {
        blobId: string;
        text: string;
        parsedWith: string;
      }) {
        yield* db
          .update(attachmentBlobs)
          .set({ parsedText: input.text, parsedWith: input.parsedWith })
          .where(eq(attachmentBlobs.id, input.blobId))
          .pipe(Effect.orDie);
      });

      const scannedPages = Effect.fn("AttachmentRepo.scannedPages")(function* (input: {
        blobId: string;
        engine: string;
      }) {
        const [row] = yield* db
          .select({ scannedPages: attachmentBlobs.scannedPages })
          .from(attachmentBlobs)
          .where(eq(attachmentBlobs.id, input.blobId))
          .pipe(Effect.orDie);
        const stored = row?.scannedPages;
        if (!stored || stored.engine !== input.engine) return {};
        return Object.fromEntries(
          Object.entries(stored.pages).map(([page, text]) => [Number(page), text]),
        );
      });

      const saveScannedPages = Effect.fn("AttachmentRepo.saveScannedPages")(function* (input: {
        blobId: string;
        engine: string;
        pages: Record<number, string>;
      }) {
        // One statement, so two readers of the same blob cannot drop each other's pages.
        const added = JSON.stringify(input.pages);
        yield* db
          .update(attachmentBlobs)
          .set({
            scannedPages: sql`jsonb_build_object(
              'engine', ${input.engine}::text,
              'pages', case when ${attachmentBlobs.scannedPages}->>'engine' = ${input.engine}::text
                then coalesce(${attachmentBlobs.scannedPages}->'pages', '{}'::jsonb) || ${added}::jsonb
                else ${added}::jsonb end
            )`,
          })
          .where(eq(attachmentBlobs.id, input.blobId))
          .pipe(Effect.orDie);
      });

      const recordBlobCandidate = Effect.fn("AttachmentRepo.recordBlobCandidate")(function* (
        storageKey: string,
      ) {
        yield* db
          .insert(blobCleanupIntents)
          .values({ storageKey, kind: "candidate" })
          // A key already marked for deletion stays marked: it is the same
          // question either way, does any row own these bytes?
          .onConflictDoNothing()
          .pipe(Effect.orDie);
      });

      const clearBlobIntents = Effect.fn("AttachmentRepo.clearBlobIntents")(function* (
        storageKeys: ReadonlyArray<string>,
      ) {
        if (storageKeys.length === 0) return;
        yield* db
          .delete(blobCleanupIntents)
          .where(inArray(blobCleanupIntents.storageKey, [...storageKeys]))
          .pipe(Effect.orDie);
      });

      const claimBlobCleanup = Effect.fn("AttachmentRepo.claimBlobCleanup")(function* (input: {
        limit: number;
        candidateCutoff: Date;
        retryAfter: Date;
      }) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Due-ness uses the database's clock (matches not_before/created_at),
              // never a JS Date: skew would hide rows that are already due, and a
              // silent reconciler is the failure this ledger exists to prevent.
              const due = yield* tx
                .select()
                .from(blobCleanupIntents)
                .where(
                  and(
                    sql`${blobCleanupIntents.notBefore} <= now()`,
                    // An upload in flight is not yet evidence of anything.
                    or(
                      eq(blobCleanupIntents.kind, "orphan"),
                      lte(blobCleanupIntents.createdAt, input.candidateCutoff),
                    ),
                  ),
                )
                .orderBy(asc(blobCleanupIntents.notBefore))
                .limit(input.limit)
                .for("update", { skipLocked: true });
              if (due.length === 0) return [] as string[];

              // Ownership, never the caller's error, decides a candidate: the
              // registration may have committed even though it reported failure.
              const owned = new Set(
                (yield* tx
                  .select({ storageKey: attachmentBlobs.storageKey })
                  .from(attachmentBlobs)
                  .where(
                    inArray(
                      attachmentBlobs.storageKey,
                      due.map((row) => row.storageKey),
                    ),
                  )).map((row) => row.storageKey),
              );
              const settled = due
                .filter((row) => owned.has(row.storageKey))
                .map((row) => row.storageKey);
              if (settled.length > 0)
                yield* tx
                  .delete(blobCleanupIntents)
                  .where(inArray(blobCleanupIntents.storageKey, settled));
              const removable = due
                .filter((row) => !owned.has(row.storageKey))
                .map((row) => row.storageKey);
              if (removable.length > 0)
                yield* tx
                  .update(blobCleanupIntents)
                  .set({
                    attempts: sql`${blobCleanupIntents.attempts} + 1`,
                    notBefore: input.retryAfter,
                  })
                  .where(inArray(blobCleanupIntents.storageKey, removable));
              return removable;
            }),
          )
          .pipe(Effect.orDie);
      });

      const claimForDocument = Effect.fn("AttachmentRepo.claimForDocument")(function* (
        tx: DbTx,
        input: { userId: string; documentId: string; attachmentId: string },
      ) {
        // The blob lock is what keeps two owner tables from both claiming one
        // upload; the unique index only covers this table.
        yield* lockAttachmentBlobs(tx, [input.attachmentId]).pipe(Effect.orDie);
        const [free] = yield* tx
          .select({ mediaType: attachmentBlobs.mediaType })
          .from(attachments)
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(
            and(
              eq(attachments.id, input.attachmentId),
              eq(attachments.userId, input.userId),
              unclaimed,
            ),
          )
          .pipe(Effect.orDie);
        if (!free || attachmentKind(free.mediaType) !== "image") return false;
        yield* tx
          .insert(documentImages)
          .values({ documentId: input.documentId, attachmentId: input.attachmentId })
          .pipe(Effect.orDie);
        return true;
      });

      const findDocumentImage = Effect.fn("AttachmentRepo.findDocumentImage")(function* (
        documentId: string,
        attachmentId: string,
      ) {
        const [row] = yield* db
          .select(withBlobColumns)
          .from(documentImages)
          .innerJoin(attachments, eq(attachments.id, documentImages.attachmentId))
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(
            and(
              eq(documentImages.documentId, documentId),
              eq(documentImages.attachmentId, attachmentId),
            ),
          )
          .pipe(Effect.orDie);
        return row ?? null;
      });

      const sweepUnclaimed = Effect.fn("AttachmentRepo.sweepUnclaimed")(function* (
        olderThan: Date,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const stale = yield* tx
                .select({ id: attachments.id })
                .from(attachments)
                .where(and(unclaimed, lt(attachments.createdAt, olderThan)));
              return yield* deleteAttachmentRows(
                tx,
                stale.map((row) => row.id),
                true,
              );
            }),
          )
          .pipe(Effect.orDie);
      });

      return AttachmentRepo.of({
        create,
        findBlob,
        findForAccess,
        deleteUnclaimed,
        recordBlobCandidate,
        clearBlobIntents,
        claimBlobCleanup,
        reconcile,
        reconcileQueueEntry,
        transferQueueEntry,
        releaseForQueueEntries,
        listForQueueEntries,
        cloneForMessages,
        releaseForMessages,
        releaseWorkingFiles,
        listForMessages,
        listForConversation,
        listWithBlobsForMessages,
        listWithBlobsByIds,
        cacheParsedText,
        scannedPages,
        saveScannedPages,
        claimForDocument,
        findDocumentImage,
        sweepUnclaimed,
      });
    }),
  );
}
