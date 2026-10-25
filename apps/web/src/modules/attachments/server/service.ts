import { Context, Duration, Effect, Layer, Schedule } from "effect";
import {
  AttachmentBusy,
  AttachmentNotAvailable,
  AttachmentRejected,
  BlobStoreError,
} from "../errors.ts";
import { attachmentKind, type AttachmentKind } from "../constants.ts";
import { readImageSize } from "../image-header.ts";
import type { Attachment } from "../schema.ts";
import { BlobStore, blobStorageKey, userBlobPrefix } from "./blob-store.ts";
import { canAccessAttachment } from "./policy.ts";
import { AttachmentRepo, type AttachmentAssociation } from "./repo.ts";
import { validateAttachment } from "./validation.ts";
import { sha256Hex } from "./sha256.ts";
import { m } from "~/paraglide/messages.js";
import { localized } from "~/i18n/localized.ts";

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
    /**
     * Uploads a person's free image upload again as `toUserId`'s own, whose
     * blob outlives the person. Null when it is not such an upload.
     */
    copyImage(input: {
      userId: string;
      attachmentId: string;
      toUserId: string;
    }): Effect.Effect<string | null>;
    /** Removes an upload the user has not sent yet. */
    remove(input: {
      userId: string;
      attachmentId: string;
    }): Effect.Effect<void, AttachmentNotAvailable>;
    /** Takes a file out of a sent message in the person's own chat, to free its room. */
    removeFromChat(input: {
      userId: string;
      attachmentId: string;
    }): Effect.Effect<{ conversationId: string }, AttachmentNotAvailable | AttachmentBusy>;
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
     * A document's image, for a reader the document has already admitted:
     * the claim, not the uploader, decides which bytes this may return.
     */
    readDocumentImage(input: {
      documentId: string;
      attachmentId: string;
    }): Effect.Effect<AttachmentBytes, AttachmentNotAvailable>;
    /**
     * Removes bytes whose last row a committed transaction just deleted.
     * Callers pass the keys those repo methods returned.
     */
    deleteBlobs(keys: ReadonlyArray<string>): Effect.Effect<void>;
    /**
     * Writes bytes under a user's content-addressed key, recorded first as a
     * cleanup candidate so bytes no row comes to own are still removed.
     */
    storeBlob(userId: string, bytes: Uint8Array): Effect.Effect<StoredBlob>;
    /**
     * After the owning rows commit: deletes the keys left unused (a dedupe
     * loser, pruned versions) and settles the candidates rows now own.
     */
    settleBlobs(stored: ReadonlyArray<string>, unused: ReadonlyArray<string>): Effect.Effect<void>;
    /** Physical cleanup for a deleted user; DB rows go via FK cascade. */
    purgeUserFiles(userId: string): Effect.Effect<void>;
  }
>()("chat/attachments/AttachmentService") {
  static readonly layer = Layer.effect(
    AttachmentService,
    Effect.gen(function* () {
      const repo = yield* AttachmentRepo;
      const store = yield* BlobStore;

      const { deleteBlobs, storeBlob, settleBlobs, upload, copyImage } = attachmentWriter(
        repo,
        store,
      );

      const remove = Effect.fn("AttachmentService.remove")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const keys = yield* repo.deleteUnclaimed(input.userId, input.attachmentId);
        yield* deleteBlobs(keys);
      });

      const removeFromChat = Effect.fn("AttachmentService.removeFromChat")(function* (input: {
        userId: string;
        attachmentId: string;
      }) {
        const { keys, conversationId } = yield* repo.deleteFromChat(
          input.userId,
          input.attachmentId,
        );
        yield* deleteBlobs(keys);
        return { conversationId };
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
        const { attachment } = record;
        // An image stored before sizes were recorded gets one for its next reader.
        const unsized =
          attachmentKind(attachment.mediaType) === "image" && attachment.width === null;
        return {
          fileName: attachment.fileName,
          mediaType: attachment.mediaType,
          size: attachment.size,
          sha256: attachment.sha256,
          bytes: store.get(attachment.storageKey).pipe(
            // Rows without bytes mean the store and the database drifted; that is
            // a server fault, not a "not found" for the caller to interpret.
            Effect.tapError((error) => Effect.logError("attachment bytes missing", error)),
            Effect.orDie,
            Effect.tap((bytes) => {
              const dimensions = unsized ? readImageSize(bytes, attachment.mediaType) : null;
              return dimensions
                ? repo.cacheDimensions({ blobId: attachment.blobId, dimensions })
                : Effect.void;
            }),
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

      const readDocumentImage = Effect.fn("AttachmentService.readDocumentImage")(function* (input: {
        documentId: string;
        attachmentId: string;
      }) {
        const image = yield* repo.findDocumentImage(input.documentId, input.attachmentId);
        if (!image) return yield* new AttachmentNotAvailable({ attachmentId: input.attachmentId });
        return {
          fileName: image.fileName,
          mediaType: image.mediaType,
          size: image.size,
          bytes: yield* store.get(image.storageKey).pipe(
            Effect.tapError((error) => Effect.logError("attachment bytes missing", error)),
            Effect.orDie,
          ),
        } satisfies AttachmentBytes;
      });

      const purgeUserFiles = Effect.fn("AttachmentService.purgeUserFiles")(function* (
        userId: string,
      ) {
        yield* store.deletePrefix(userBlobPrefix(userId)).pipe(Effect.orDie);
      });

      const sweep = Effect.gen(function* () {
        const keys = yield* repo.sweepUnclaimed(ORPHAN_GRACE);
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
        const keys = yield* repo.claimBlobCleanup({
          limit: RECONCILE_BATCH,
          candidateGrace: CANDIDATE_GRACE,
          retryBackoff: RECONCILE_BACKOFF,
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

      return AttachmentService.of({
        upload,
        copyImage,
        remove,
        removeFromChat,
        read,
        open,
        readDocumentImage,
        deleteBlobs,
        storeBlob,
        settleBlobs,
        purgeUserFiles,
      });
    }),
  );
}

/**
 * Writing stored files, for the attachment service and for anything that
 * registers bytes outside it: the cleanup ledger is kept the same way by all.
 */
export const attachmentWriter = (repo: AttachmentRepo["Service"], store: BlobStore["Service"]) => {
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

  const storeBlob = Effect.fn("AttachmentService.storeBlob")(function* (
    userId: string,
    bytes: Uint8Array,
  ) {
    // Hashed here, over the bytes we actually received: a client-supplied
    // hash would be both untrustworthy and a free existence oracle.
    const sha256 = sha256Hex(bytes);
    const storageKey = blobStorageKey(userId, sha256);
    // Before the bytes exist: an interrupted upload leaves an object whose
    // row never landed, and nothing that follows rows could ever find it.
    yield* repo.recordBlobCandidate(storageKey);
    yield* store.put(storageKey, bytes).pipe(Effect.orDie);
    return { sha256, storageKey } satisfies StoredBlob;
  });

  // A dedupe winner owns a different key, so only our unused candidate goes;
  // never the shared winner's bytes. What a row owns is no longer a candidate.
  const settleBlobs = (stored: ReadonlyArray<string>, unused: ReadonlyArray<string>) =>
    deleteBlobs(unused).pipe(
      Effect.andThen(() => {
        const owned = stored.filter((key) => !unused.includes(key));
        return owned.length > 0 ? repo.clearBlobIntents(owned) : Effect.void;
      }),
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
        reason: localized(m.attachments_error_pdf_or_text),
      });

    if (input.association) yield* repo.admitAssociation(input.association);

    const { sha256, storageKey } = yield* storeBlob(input.userId, input.bytes);
    const { attachment, unusedStorageKey } = yield* repo.create({
      ...(input.association ? { association: input.association } : {}),
      userId: input.userId,
      sha256,
      storageKey,
      size: input.bytes.length,
      mediaType: validated.mediaType,
      dimensions:
        validated.kind === "image" ? readImageSize(input.bytes, validated.mediaType) : null,
      fileName: validated.fileName,
    });
    yield* settleBlobs([storageKey], unusedStorageKey ? [unusedStorageKey] : []);
    return attachment;
  });

  const copyImage = Effect.fn("AttachmentService.copyImage")(function* (input: {
    userId: string;
    attachmentId: string;
    toUserId: string;
  }) {
    const image = yield* repo.findFreeImage(input.userId, input.attachmentId);
    if (!image) return null;
    const bytes = yield* store.get(image.storageKey).pipe(
      Effect.tapError((error) => Effect.logError("attachment bytes missing", error)),
      Effect.orDie,
    );
    return yield* upload({
      userId: input.toUserId,
      fileName: image.fileName,
      declaredMediaType: image.mediaType,
      bytes,
      allowedKinds: ["image"],
    }).pipe(
      Effect.map((copy) => copy.id),
      Effect.catchTag("AttachmentRejected", () => Effect.succeed(null)),
    );
  });

  return { deleteBlobs, storeBlob, settleBlobs, upload, copyImage };
};

/** Bytes written under their content key, not yet owned by a committed row. */
export interface StoredBlob {
  readonly sha256: string;
  readonly storageKey: string;
}

const logBlobFailure = (error: BlobStoreError) =>
  Effect.logError(`failed to delete blob ${error.key}: ${error.message}`);
