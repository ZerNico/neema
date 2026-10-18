import { and, asc, desc, eq, not, or, sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer, Schedule, Schema } from "effect";
import {
  attachmentBlobs,
  attachments,
  conversationWorkingFiles,
  conversations,
  messages,
} from "~/db/schema/index.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import type { AttachmentRejected } from "~/modules/attachments/errors.ts";
import type { OfficeFamily } from "~/modules/office/names.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { lockGeneration, type GenerationIdentity } from "./generation-fence.ts";
import {
  KEPT_WORKING_FILES_OFFERED,
  type KeptWorkingFile,
  type KeptWorkingFileOwner,
  type WorkingFileSnapshot,
} from "./working-files.ts";

/** A kept revision nobody has changed for this long is dropped, judged by the database clock. */
const RETENTION_DAYS = 14;
const fresh = sql`${conversationWorkingFiles.updatedAt} > now() - make_interval(days => ${RETENTION_DAYS})`;
const SWEEP_EVERY = Duration.minutes(10);
const SWEEP_BATCH = 100;

export class KeptWorkingFileUnavailable extends Schema.TaggedError<KeptWorkingFileUnavailable>()(
  "KeptWorkingFileUnavailable",
  { reason: Schema.String },
) {}

type Row = typeof conversationWorkingFiles.$inferSelect;
const ownerOf = (row: Row): KeptWorkingFileOwner =>
  row.owner === "custom" ? `custom:${row.customToolId ?? ""}` : row.owner;

/** This answer's row for a file, locked, if it has one yet. */
const ownRow = (tx: DbTx, fence: GenerationIdentity, workingFileId: string) =>
  tx
    .select({ attachmentId: conversationWorkingFiles.attachmentId })
    .from(conversationWorkingFiles)
    .where(
      and(
        eq(conversationWorkingFiles.workingFileId, workingFileId),
        eq(conversationWorkingFiles.messageId, fence.messageId),
      ),
    )
    .for("update")
    .pipe(
      Effect.orDie,
      Effect.map(([row]) => row),
    );

/**
 * Each file's state is its row from the latest answer that touched it; the
 * first answer's row names who created it. Rows are few per chat.
 */
export const readKeptWorkingFiles = (db: Pick<DbTx, "select">, conversationId: string) =>
  db
    .select({ row: conversationWorkingFiles, current: sql<boolean>`${fresh}` })
    .from(conversationWorkingFiles)
    .innerJoin(messages, eq(messages.id, conversationWorkingFiles.messageId))
    .where(eq(conversationWorkingFiles.conversationId, conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const files = new Map<string, { latest: Row; current: boolean; createdBy: string }>();
        for (const { row, current } of rows) {
          const file = files.get(row.workingFileId);
          if (file) file.createdBy = row.messageId;
          else files.set(row.workingFileId, { latest: row, current, createdBy: row.messageId });
        }
        return [...files.values()]
          .filter((file) => file.latest.attachmentId !== null && file.current)
          .toSorted((a, b) => b.latest.updatedAt.getTime() - a.latest.updatedAt.getTime());
      }),
    );

/**
 * The durable half of working files: what each answer left of the drafts it
 * changed, so a later answer can continue them and a retry can restore them.
 * See docs/internals/files.md.
 */
export class KeptWorkingFiles extends Context.Service<
  KeptWorkingFiles,
  {
    /** The newest current drafts of a chat, for a new answer to continue. */
    list(conversationId: string): Effect.Effect<ReadonlyArray<KeptWorkingFile>>;
    load(file: KeptWorkingFile): Effect.Effect<Uint8Array, KeptWorkingFileUnavailable>;
    /** Saves the answer's latest revision of a file in place of its earlier one. */
    keep(
      fence: GenerationIdentity,
      file: WorkingFileSnapshot & { owner: KeptWorkingFileOwner },
    ): Effect.Effect<void, AttachmentRejected>;
    /**
     * Records, inside a publication's transaction, that this answer delivered
     * the file. Earlier answers' rows stay, so retrying this one brings the
     * draft back. Returns storage keys to delete after commit.
     */
    consume(
      tx: DbTx,
      fence: GenerationIdentity,
      workingFileId: string,
    ): Effect.Effect<ReadonlyArray<string>>;
    /** Drops expired rows in bounded batches; returns how many went. */
    sweep(): Effect.Effect<number>;
  }
>()("chat/KeptWorkingFiles") {
  static readonly layer = Layer.effect(
    KeptWorkingFiles,
    Effect.gen(function* () {
      const db = yield* Db;
      const repo = yield* AttachmentRepo;
      const service = yield* AttachmentService;
      const store = yield* BlobStore;
      const bus = yield* SyncBus;

      const list = (conversationId: string) =>
        readKeptWorkingFiles(db, conversationId).pipe(
          Effect.map((files) =>
            files.slice(0, KEPT_WORKING_FILES_OFFERED).map(({ latest }): KeptWorkingFile => ({
              ref: { kind: "working", id: latest.workingFileId, revision: latest.revision },
              name: latest.name,
              mediaType: latest.mediaType,
              fingerprint: latest.fingerprint,
              owner: ownerOf(latest),
              attachmentId: latest.attachmentId!,
              ...(latest.source ? { source: latest.source } : {}),
            })),
          ),
        );

      const load = (file: KeptWorkingFile) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select({ storageKey: attachmentBlobs.storageKey })
            .from(conversationWorkingFiles)
            .innerJoin(attachments, eq(attachments.id, conversationWorkingFiles.attachmentId))
            .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
            .where(eq(conversationWorkingFiles.attachmentId, file.attachmentId))
            .pipe(Effect.orDie);
          if (!row)
            return yield* new KeptWorkingFileUnavailable({
              reason: "This working file is no longer kept.",
            });
          return yield* store.get(row.storageKey).pipe(
            Effect.mapError(
              () =>
                new KeptWorkingFileUnavailable({
                  reason: "This working file could not be read.",
                }),
            ),
          );
        });

      const keep = (
        fence: GenerationIdentity,
        file: WorkingFileSnapshot & { owner: KeptWorkingFileOwner },
      ) =>
        Effect.gen(function* () {
          let discard: ReadonlyArray<string> = [];
          const custom = file.owner.startsWith("custom:");
          // A source imported from the computer lived only in its own answer.
          const source = file.source?.startsWith("working:") ? null : (file.source ?? null);
          yield* service.upload({
            userId: fence.userId,
            fileName: file.name,
            declaredMediaType: file.mediaType,
            bytes: file.bytes,
            association: {
              before: (tx) => lockGeneration(tx, fence).pipe(Effect.asVoid),
              after: (tx, attachment) =>
                Effect.gen(function* () {
                  const previous = yield* ownRow(tx, fence, file.ref.id);
                  const values = {
                    attachmentId: attachment.id,
                    name: file.name,
                    mediaType: file.mediaType,
                    owner: custom ? ("custom" as const) : (file.owner as OfficeFamily),
                    customToolId: custom ? file.owner.slice("custom:".length) : null,
                    revision: file.ref.revision,
                    fingerprint: file.fingerprint,
                    source,
                    updatedAt: sql`now()`,
                  };
                  yield* tx
                    .insert(conversationWorkingFiles)
                    .values({
                      ...values,
                      workingFileId: file.ref.id,
                      messageId: fence.messageId,
                      conversationId: fence.conversationId,
                    })
                    .onConflictDoUpdate({
                      target: [
                        conversationWorkingFiles.workingFileId,
                        conversationWorkingFiles.messageId,
                      ],
                      set: values,
                    })
                    .pipe(Effect.orDie);
                  if (previous?.attachmentId)
                    discard = yield* repo.releaseWorkingFiles(tx, [previous.attachmentId]);
                }),
            },
          });
          yield* service.deleteBlobs(discard);
        });

      const consume = (tx: DbTx, fence: GenerationIdentity, workingFileId: string) =>
        Effect.gen(function* () {
          const [latest] = yield* tx
            .select()
            .from(conversationWorkingFiles)
            .where(
              and(
                eq(conversationWorkingFiles.conversationId, fence.conversationId),
                eq(conversationWorkingFiles.workingFileId, workingFileId),
              ),
            )
            .orderBy(desc(conversationWorkingFiles.updatedAt))
            .limit(1)
            .pipe(Effect.orDie);
          // Created and delivered by this answer alone: nothing was kept.
          if (!latest) return [] as ReadonlyArray<string>;
          const previous = yield* ownRow(tx, fence, workingFileId);
          const values = { ...latest, attachmentId: null, updatedAt: sql`now()` };
          yield* tx
            .insert(conversationWorkingFiles)
            .values({ ...values, messageId: fence.messageId })
            .onConflictDoUpdate({
              target: [conversationWorkingFiles.workingFileId, conversationWorkingFiles.messageId],
              set: { attachmentId: null, updatedAt: sql`now()` },
            })
            .pipe(Effect.orDie);
          return previous?.attachmentId
            ? yield* repo.releaseWorkingFiles(tx, [previous.attachmentId])
            : [];
        });

      const sweep = Effect.fn("KeptWorkingFiles.sweep")(function* () {
        let removed = 0;
        for (;;) {
          const batch = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const expired = yield* tx
                  .select({
                    workingFileId: conversationWorkingFiles.workingFileId,
                    messageId: conversationWorkingFiles.messageId,
                    conversationId: conversationWorkingFiles.conversationId,
                    userId: conversations.userId,
                  })
                  .from(conversationWorkingFiles)
                  .innerJoin(
                    conversations,
                    eq(conversations.id, conversationWorkingFiles.conversationId),
                  )
                  .where(not(fresh))
                  .orderBy(asc(conversationWorkingFiles.updatedAt))
                  .limit(SWEEP_BATCH)
                  .for("update", { of: conversationWorkingFiles, skipLocked: true });
                if (expired.length === 0) return { expired, keys: [] as ReadonlyArray<string> };
                const deleted = yield* tx
                  .delete(conversationWorkingFiles)
                  .where(
                    or(
                      ...expired.map((row) =>
                        and(
                          eq(conversationWorkingFiles.workingFileId, row.workingFileId),
                          eq(conversationWorkingFiles.messageId, row.messageId),
                        ),
                      ),
                    ),
                  )
                  .returning({ attachmentId: conversationWorkingFiles.attachmentId });
                const keys = yield* repo.releaseWorkingFiles(
                  tx,
                  deleted.flatMap((row) => (row.attachmentId ? [row.attachmentId] : [])),
                );
                return { expired, keys };
              }),
            )
            .pipe(Effect.orDie);
          yield* service.deleteBlobs(batch.keys);
          // Open tabs name kept drafts in the rewind confirmation.
          const touched = new Map(batch.expired.map((row) => [row.conversationId, row.userId]));
          yield* Effect.forEach(
            touched,
            ([conversationId, userId]) =>
              bus.publish(userId, { type: "conversation.updated", conversationId }),
            { discard: true },
          );
          removed += batch.expired.length;
          if (batch.expired.length < SWEEP_BATCH) return removed;
        }
      });

      yield* sweep().pipe(
        Effect.catchCause((cause) => Effect.logError("kept working file sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
        Effect.forkScoped,
      );

      return KeptWorkingFiles.of({ list, load, keep, consume, sweep });
    }),
  );
}
