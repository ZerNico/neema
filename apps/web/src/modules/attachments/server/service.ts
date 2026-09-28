import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { AttachmentNotAvailable, AttachmentRejected, BlobStoreError } from "../errors.ts";
import type { AttachmentKind } from "../constants.ts";
import type { Attachment } from "../schema.ts";
import { BlobStore, blobStorageKey, userBlobPrefix } from "./blob-store.ts";
import { canAccessAttachment } from "./policy.ts";
import { AttachmentRepo, type AttachmentAssociation } from "./repo.ts";
import { validateAttachment } from "./validation.ts";
import { sha256Hex } from "./sha256.ts";

// Uploads that were never sent (tab closed, draft abandoned) are swept once a
// day's grace has passed. The sweep also runs at startup so a restart does not
// postpone it indefinitely.
const ORPHAN_GRACE = Duration.hours(24);
const SWEEP_INTERVAL = Duration.hours(6);
// Leaked objects are not urgent, but they are invisible: reconcile often
// enough that a crashed upload or a lost delete is measured in minutes.
const RECONCILE_INTERVAL = Duration.minutes(5);
const RECONCILE_BATCH = 100;
// An upload in flight owns no row yet; only older candidates are decidable.
const CANDIDATE_GRACE = Duration.minutes(30);
const RECONCILE_BACKOFF = Duration.minutes(15);

export interface AttachmentBytes {
  fileName: string;
  mediaType: string;
  size: number;
  bytes: Uint8Array;
}

export class AttachmentService extends Context.Service<
  AttachmentService,
  {
    upload(input: {
      userId: string;
      fileName: string;
      declaredMediaType: string;
      bytes: Uint8Array;
      allowedKinds?: ReadonlyArray<AttachmentKind>;
      association?: AttachmentAssociation;
    }): Effect.Effect<Attachment, AttachmentRejected>;
    /** Removes an upload the user has not sent yet. */
    remove(input: {
      userId: string;
      attachmentId: string;
    }): Effect.Effect<void, AttachmentNotAvailable>;
    /** Reads bytes for serving, enforcing the access policy. */
    read(input: {
      userId: string;
      attachmentId: string;
    }): Effect.Effect<AttachmentBytes, AttachmentNotAvailable>;
    /**
     * The access check and metadata alone; bytes load only when asked, so a
     * cached derivative of the content can be served without reading them.
     */
    open(input: {
      userId: string;
      attachmentId: string;
    }): Effect.Effect<
      Omit<AttachmentBytes, "bytes"> & { sha256: string; bytes: Effect.Effect<Uint8Array> },
      AttachmentNotAvailable
    >;
    /**
     * Removes bytes whose last row a committed transaction just deleted.
     * Callers pass the keys those repo methods returned.
     */
    deleteBlobs(keys: ReadonlyArray<string>): Effect.Effect<void>;
    /** Physical cleanup for a deleted user; DB rows go via FK cascade. */
    purgeUserFiles(userId: string): Effect.Effect<void>;
  }
>()("chat/attachments/AttachmentService") {
  static readonly layer = Layer.effect(
    AttachmentService,
    Effect.gen(function* () {
      const repo = yield* AttachmentRepo;
      const store = yield* BlobStore;

      // Physical deletion trails the commit so a rolled-back transaction never
      // orphans deleted bytes. The reverse case, bytes with no row, is covered
      // by the cleanup ledger: `collectOrphanedBlobs` and uploads both record
      // intent first, so an interrupted delete or crashed upload gets finished
      // by the reconciler, not leaked.
      const deleteBlobs = (keys: ReadonlyArray<string>) =>
        Effect.forEach(
          keys,
          (key) =>
            store
              .delete(key)
              .pipe(
                Effect.andThen(repo.clearBlobIntents([key])),
                Effect.catchTag("BlobStoreError", logBlobFailure),
              ),
          { discard: true },
        );

      const upload = Effect.fn("AttachmentService.upload")(function* (input: {
        userId: string;
        fileName: string;
        declaredMediaType: string;
        bytes: Uint8Array;
        allowedKinds?: ReadonlyArray<AttachmentKind>;
        association?: AttachmentAssociation;
      }) {
        const validated = yield* validateAttachment({
          fileName: input.fileName,
          declaredMediaType: input.declaredMediaType,
          bytes: input.bytes,
        });

        if (input.allowedKinds && !input.allowedKinds.includes(validated.kind))
          return yield* new AttachmentRejected({
            cause: "type",
            reason: "upload a PDF or text document",
          });

        // Hashed here, over the bytes we actually received: a client-supplied
        // hash would be both untrustworthy and a free existence oracle.
        const sha256 = sha256Hex(input.bytes);
        const storageKey = blobStorageKey(input.userId, sha256);

        // Before the bytes exist: an interrupted upload leaves an object whose
        // row never landed, and nothing that follows rows could ever find it.
        yield* repo.recordBlobCandidate(storageKey);
        yield* store.put(storageKey, input.bytes).pipe(Effect.orDie);

        const { attachment, unusedStorageKey } = yield* repo.create({
          ...(input.association ? { association: input.association } : {}),
          userId: input.userId,
          sha256,
          storageKey,
          size: input.bytes.length,
          mediaType: validated.mediaType,
          fileName: validated.fileName,
        });
        // A concurrent dedup winner owns a different key. Only our unreferenced
        // candidate is disposable; never delete the shared winner's bytes.
        if (unusedStorageKey) yield* deleteBlobs([unusedStorageKey]);
        // The key a row now owns is no longer a candidate for removal.
        else yield* repo.clearBlobIntents([storageKey]);
        return attachment;
      });

      const remove = Effect.fn("AttachmentService.remove")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const keys = yield* repo.deleteUnclaimed(input.userId, input.attachmentId);
        yield* deleteBlobs(keys);
      });

      const open = Effect.fn("AttachmentService.open")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const record = yield* repo.findForAccess(input.attachmentId);
        // Nonexistent and forbidden are the same answer on purpose.
        if (!record || !canAccessAttachment(input.userId, record)) {
          return yield* new AttachmentNotAvailable({ attachmentId: input.attachmentId });
        }
        return {
          fileName: record.attachment.fileName,
          mediaType: record.attachment.mediaType,
          size: record.attachment.size,
          sha256: record.attachment.sha256,
          bytes: store.get(record.attachment.storageKey).pipe(
            // Rows without bytes mean the store and the database drifted; that is
            // a server fault, not a "not found" for the caller to interpret.
            Effect.tapError((error) => Effect.logError("attachment bytes missing", error)),
            Effect.orDie,
          ),
        };
      });

      const read = Effect.fn("AttachmentService.read")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const file = yield* open(input);
        return {
          fileName: file.fileName,
          mediaType: file.mediaType,
          size: file.size,
          bytes: yield* file.bytes,
        } satisfies AttachmentBytes;
      });

      const purgeUserFiles = Effect.fn("AttachmentService.purgeUserFiles")(function* (
        userId: string,
      ) {
        yield* store.deletePrefix(userBlobPrefix(userId)).pipe(Effect.orDie);
      });

      const sweep = Effect.gen(function* () {
        const cutoff = new Date(Date.now() - Duration.toMillis(ORPHAN_GRACE));
        const keys = yield* repo.sweepUnclaimed(cutoff);
        if (keys.length > 0) {
          yield* Effect.logInfo(`swept ${keys.length} abandoned attachment(s)`);
          yield* deleteBlobs(keys);
        }
      });

      // Finishes work whose two halves could not be atomic: bytes stored for a
      // row that never committed, and rows deleted before their bytes were.
      // Ownership decides, so a registration that committed after its caller
      // failed keeps its bytes.
      const reconcile = Effect.gen(function* () {
        const now = Date.now();
        const keys = yield* repo.claimBlobCleanup({
          limit: RECONCILE_BATCH,
          candidateCutoff: new Date(now - Duration.toMillis(CANDIDATE_GRACE)),
          retryAfter: new Date(now + Duration.toMillis(RECONCILE_BACKOFF)),
        });
        if (keys.length === 0) return;
        yield* Effect.logInfo(`reconciling ${keys.length} unreferenced blob object(s)`);
        yield* deleteBlobs(keys);
      });

      yield* sweep.pipe(
        Effect.catchCause((cause) => Effect.logError("attachment sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
        Effect.forkScoped,
      );
      yield* reconcile.pipe(
        Effect.catchCause((cause) => Effect.logError("blob reconciliation failed", cause)),
        Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)),
        Effect.forkScoped,
      );

      return AttachmentService.of({ upload, remove, read, open, deleteBlobs, purgeUserFiles });
    }),
  );
}

const logBlobFailure = (error: BlobStoreError) =>
  Effect.logError(`failed to delete blob ${error.key}: ${error.message}`);
