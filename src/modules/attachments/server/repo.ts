import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import {
  attachmentBlobs,
  attachments,
  conversations,
  messageAttachments,
  messages,
} from "~/db/schema/index.ts";
import { attachmentKind } from "../constants.ts";
import type { Attachment, MessageAttachment } from "../schema.ts";
import { AttachmentNotAvailable } from "../errors.ts";

export type AttachmentRow = typeof attachments.$inferSelect;
export type AttachmentBlobRow = typeof attachmentBlobs.$inferSelect;

/** The transaction handle `Db.transaction` hands its callback. */
export type DbTx = Parameters<Parameters<Db["Service"]["transaction"]>[0]>[0];

/** Attachment joined with its blob — everything the prompt builder needs. */
export interface AttachmentWithBlob {
  id: string;
  userId: string;
  fileName: string;
  blobId: string;
  storageKey: string;
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
  size: attachmentBlobs.size,
  mediaType: attachmentBlobs.mediaType,
  parsedText: attachmentBlobs.parsedText,
  parsedWith: attachmentBlobs.parsedWith,
};

// Deletes attachment rows and any blob left with no references, returning the
// storage keys whose bytes the caller must remove after the commit. Physical
// deletion is deliberately outside the transaction: a rolled-back transaction
// must never leave the store missing bytes it still has rows for.
// Postgres unique_violation, wherever the driver buried it in the cause
// chain. Anything else raised during the claim insert is a real fault and
// must not be dressed up as a user-level conflict.
const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    if (
      typeof (current as { message?: unknown }).message === "string" &&
      (current as { message: string }).message.includes("duplicate key value")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const deleteAttachmentRows = (tx: DbTx, attachmentIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (attachmentIds.length === 0) return [] as string[];
    const rows = yield* tx
      .select({ blobId: attachments.blobId })
      .from(attachments)
      .where(inArray(attachments.id, [...attachmentIds]));
    yield* tx.delete(attachments).where(inArray(attachments.id, [...attachmentIds]));

    const blobIds = [...new Set(rows.map((row) => row.blobId))];
    if (blobIds.length === 0) return [] as string[];
    const orphaned = yield* tx
      .select({ id: attachmentBlobs.id, storageKey: attachmentBlobs.storageKey })
      .from(attachmentBlobs)
      .where(
        and(
          inArray(attachmentBlobs.id, blobIds),
          sql`not exists (select 1 from ${attachments} where ${attachments.blobId} = ${attachmentBlobs.id})`,
        ),
      );
    if (orphaned.length > 0) {
      yield* tx.delete(attachmentBlobs).where(
        inArray(
          attachmentBlobs.id,
          orphaned.map((blob) => blob.id),
        ),
      );
    }
    return orphaned.map((blob) => blob.storageKey);
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
      userId: string;
      sha256: string;
      storageKey: string;
      size: number;
      mediaType: string;
      fileName: string;
    }): Effect.Effect<{ attachment: Attachment; deduped: boolean }>;
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
    /**
     * Copies the attachments of each source message onto its target message,
     * inside the caller's transaction (branching). Blobs are shared, not
     * duplicated — only the attachment rows and links are new.
     */
    cloneForMessages(
      tx: DbTx,
      input: {
        userId: string;
        messages: ReadonlyArray<{ sourceMessageId: string; targetMessageId: string }>;
      },
    ): Effect.Effect<void>;
    /** Releases every attachment linked to these messages (rewind/delete). */
    releaseForMessages(
      tx: DbTx,
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>>;
    /** Flat conversation projection, mirroring how tool calls are shipped. */
    listForMessages(
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<MessageAttachment>>;
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
    /** Unclaimed uploads older than the cutoff (tab closed before sending). */
    sweepUnclaimed(olderThan: Date): Effect.Effect<ReadonlyArray<string>>;
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
              const existing = yield* selectBlob(tx, input.userId, input.sha256);
              let blob = existing[0];
              if (!blob) {
                const inserted = yield* tx
                  .insert(attachmentBlobs)
                  .values({
                    id: uuidv7(),
                    userId: input.userId,
                    sha256: input.sha256,
                    storageKey: input.storageKey,
                    size: input.size,
                    mediaType: input.mediaType,
                  })
                  .onConflictDoNothing()
                  .returning();
                // A concurrent upload of the same bytes won the insert race.
                blob = inserted[0] ?? (yield* selectBlob(tx, input.userId, input.sha256))[0]!;
              }
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
              return {
                attachment: toAttachmentDto({
                  id: row.id,
                  fileName: row.fileName,
                  size: blob.size,
                  mediaType: blob.mediaType,
                }),
                deduped: existing.length > 0,
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
        const rows = yield* db
          .select({
            ...withBlobColumns,
            claimedByMessageId: messageAttachments.messageId,
            conversationUserId: conversations.userId,
          })
          .from(attachments)
          .innerJoin(attachmentBlobs, eq(attachments.blobId, attachmentBlobs.id))
          .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
          .leftJoin(messages, eq(messages.id, messageAttachments.messageId))
          .leftJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(eq(attachments.id, attachmentId))
          .pipe(Effect.orDie);
        const row = rows[0];
        if (!row) return null;
        const { claimedByMessageId, conversationUserId, ...attachment } = row;
        return { attachment, claimedByMessageId, conversationUserId };
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
                .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
                .where(
                  and(
                    eq(attachments.id, attachmentId),
                    eq(attachments.userId, userId),
                    isNull(messageAttachments.attachmentId),
                  ),
                );
              if (rows.length === 0) return null;
              return yield* deleteAttachmentRows(tx, [attachmentId]);
            }),
          )
          .pipe(Effect.orDie);
        if (keys === null) return yield* new AttachmentNotAvailable({ attachmentId });
        return keys;
      });

      const reconcile = Effect.fn("AttachmentRepo.reconcile")(function* (
        tx: DbTx,
        input: { userId: string; messageId: string; attachmentIds: ReadonlyArray<string> },
      ) {
        const requested = input.attachmentIds;
        if (new Set(requested).size !== requested.length) {
          return yield* new AttachmentNotAvailable({ attachmentId: requested[0] ?? "" });
        }

        const linked = yield* tx
          .select({ attachmentId: messageAttachments.attachmentId })
          .from(messageAttachments)
          .where(eq(messageAttachments.messageId, input.messageId))
          .pipe(Effect.orDie);
        const previous = linked.map((row) => row.attachmentId);

        // Drop every link first so a reorder cannot trip the (message,
        // position) or (attachment) unique indexes mid-flight.
        if (previous.length > 0) {
          yield* tx
            .delete(messageAttachments)
            .where(eq(messageAttachments.messageId, input.messageId))
            .pipe(Effect.orDie);
        }

        if (requested.length > 0) {
          // Anything still linked at this point belongs to another message.
          const usable = yield* tx
            .select({ id: attachments.id })
            .from(attachments)
            .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
            .where(
              and(
                inArray(attachments.id, [...requested]),
                eq(attachments.userId, input.userId),
                isNull(messageAttachments.attachmentId),
              ),
            )
            .pipe(Effect.orDie);
          const usableIds = new Set(usable.map((row) => row.id));
          const missing = requested.find((id) => !usableIds.has(id));
          if (missing !== undefined) {
            return yield* new AttachmentNotAvailable({ attachmentId: missing });
          }

          yield* tx
            .insert(messageAttachments)
            .values(
              requested.map((attachmentId, position) => ({
                messageId: input.messageId,
                attachmentId,
                position,
              })),
            )
            .pipe(
              // The unique index on attachment_id is the real race guard: a
              // concurrent claim of the same upload loses here and rolls the
              // whole transaction back. Only that specific violation is a
              // user-level conflict — any other query error stays a defect.
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

      const cloneForMessages = Effect.fn("AttachmentRepo.cloneForMessages")(function* (
        tx: DbTx,
        input: {
          userId: string;
          messages: ReadonlyArray<{ sourceMessageId: string; targetMessageId: string }>;
        },
      ) {
        if (input.messages.length === 0) return;
        const targetOf = new Map(
          input.messages.map((m) => [m.sourceMessageId, m.targetMessageId] as const),
        );
        const linked = yield* tx
          .select({
            messageId: messageAttachments.messageId,
            position: messageAttachments.position,
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
        if (linked.length === 0) return;

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
            })),
          )
          .pipe(Effect.orDie);
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
        return yield* deleteAttachmentRows(
          tx,
          linked.map((row) => row.attachmentId),
        ).pipe(Effect.orDie);
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
          .where(inArray(messageAttachments.messageId, [...messageIds]))
          .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
          .pipe(Effect.orDie);
        return rows.map((row) => ({
          ...toAttachmentDto(row),
          messageId: row.messageId,
          position: row.position,
        }));
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
            .where(inArray(messageAttachments.messageId, [...messageIds]))
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

      const sweepUnclaimed = Effect.fn("AttachmentRepo.sweepUnclaimed")(function* (
        olderThan: Date,
      ) {
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const stale = yield* tx
                .select({ id: attachments.id })
                .from(attachments)
                .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
                .where(
                  and(
                    isNull(messageAttachments.attachmentId),
                    lt(attachments.createdAt, olderThan),
                  ),
                );
              return yield* deleteAttachmentRows(
                tx,
                stale.map((row) => row.id),
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
        reconcile,
        cloneForMessages,
        releaseForMessages,
        listForMessages,
        listWithBlobsForMessages,
        listWithBlobsByIds,
        cacheParsedText,
        sweepUnclaimed,
      });
    }),
  );
}
