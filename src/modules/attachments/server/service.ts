import { createHash } from "node:crypto";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { AttachmentNotAvailable, AttachmentRejected, BlobStoreError } from "../errors.ts";
import type { Attachment } from "../schema.ts";
import { BlobStore, blobStorageKey, userBlobPrefix } from "./blob-store.ts";
import { canAccessAttachment } from "./policy.ts";
import { AttachmentRepo } from "./repo.ts";
import { validateAttachment } from "./validation.ts";

// Uploads that were never sent (tab closed, draft abandoned) are swept once a
// day's grace has passed. The sweep also runs at startup so a restart does not
// postpone it indefinitely.
const ORPHAN_GRACE = Duration.hours(24);
const SWEEP_INTERVAL = Duration.hours(6);

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

      // Physical deletion always trails the commit, so a rolled-back
      // transaction can never leave rows pointing at deleted bytes. The
      // reverse drift (bytes with no row) is harmless and swept separately.
      const deleteBlobs = (keys: ReadonlyArray<string>) =>
        Effect.forEach(
          keys,
          (key) => store.delete(key).pipe(Effect.catchTag("BlobStoreError", logBlobFailure)),
          {
            discard: true,
          },
        );

      const upload = Effect.fn("AttachmentService.upload")(function* (input: {
        userId: string;
        fileName: string;
        declaredMediaType: string;
        bytes: Uint8Array;
      }) {
        const validated = yield* validateAttachment({
          fileName: input.fileName,
          declaredMediaType: input.declaredMediaType,
          bytes: input.bytes,
        });

        // Hashed here, over the bytes we actually received — a client-supplied
        // hash would be both untrustworthy and a free existence oracle.
        const sha256 = createHash("sha256").update(input.bytes).digest("hex");
        const storageKey = blobStorageKey(input.userId, sha256);

        yield* store.put(storageKey, input.bytes).pipe(Effect.orDie);

        const { attachment } = yield* repo.create({
          userId: input.userId,
          sha256,
          storageKey,
          size: input.bytes.length,
          mediaType: validated.mediaType,
          fileName: validated.fileName,
        });
        return attachment;
      });

      const remove = Effect.fn("AttachmentService.remove")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const keys = yield* repo.deleteUnclaimed(input.userId, input.attachmentId);
        yield* deleteBlobs(keys);
      });

      const read = Effect.fn("AttachmentService.read")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const record = yield* repo.findForAccess(input.attachmentId);
        // Nonexistent and forbidden are the same answer on purpose.
        if (!record || !canAccessAttachment(input.userId, record)) {
          return yield* new AttachmentNotAvailable({ attachmentId: input.attachmentId });
        }
        const bytes = yield* store.get(record.attachment.storageKey).pipe(
          // Rows without bytes mean the store and the database drifted; that is
          // a server fault, not a "not found" for the caller to interpret.
          Effect.tapError((error) => Effect.logError("attachment bytes missing", error)),
          Effect.orDie,
        );
        return {
          fileName: record.attachment.fileName,
          mediaType: record.attachment.mediaType,
          size: record.attachment.size,
          bytes,
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

      yield* sweep.pipe(
        Effect.catchCause((cause) => Effect.logError("attachment sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
        Effect.forkScoped,
      );

      return AttachmentService.of({ upload, remove, read, deleteBlobs, purgeUserFiles });
    }),
  );
}

const logBlobFailure = (error: BlobStoreError) =>
  Effect.logError(`failed to delete blob ${error.key}: ${error.message}`);
