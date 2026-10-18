import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  attachmentBlobs,
  attachments,
  messageAttachments,
  messageChunks,
  messages,
} from "~/db/schema/index.ts";
import { AttachmentRejected } from "~/modules/attachments/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { IMAGE_MEDIA_TYPES, type AttachmentKind } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType } from "~/modules/attachments/server/validation.ts";
import {
  type AssistantFile,
  type AssistantFileSource,
  type AssistantOutput,
  ASSISTANT_FILE_LIMITS,
  assistantFileSource,
  isGeneratedImage,
} from "../assistant-output.ts";
import {
  lockGeneration,
  lockGenerationOutput,
  type GenerationIdentity,
} from "./generation-fence.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";

/**
 * The next free position among everything the message holds. Answer files and
 * search images are written by different fibers, so neither may count only
 * its own kind.
 */
export const nextAttachmentPosition = (tx: DbTx, messageId: string) =>
  tx
    .select({ next: sql<number>`coalesce(max(${messageAttachments.position}) + 1, 0)::int` })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .pipe(
      Effect.map(([row]) => row?.next ?? 0),
      Effect.orDie,
    );

const totalBytes = (items: ReadonlyArray<AssistantFile>) =>
  items.reduce((sum, item) => sum + item.attachment.size, 0);

/** Strict base64 only: remote outputs are refused, never fetched. */
export const decodeGeneratedImage = (mediaType: string, data: string | Uint8Array) =>
  Effect.gen(function* () {
    if (!(IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType))
      return yield* new AttachmentRejected({
        cause: "type",
        reason: "The model returned an unsupported image type.",
      });
    if (
      typeof data === "string" &&
      (data.length > Math.ceil(ASSISTANT_FILE_LIMITS.bytes / 3) * 4 ||
        data.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(data) ||
        (data.indexOf("=") !== -1 &&
          data.indexOf("=") < data.length - (data.endsWith("==") ? 2 : 1)))
    )
      return yield* new AttachmentRejected({
        cause: "content",
        reason: "The model returned an invalid or oversized image.",
      });
    const bytes = typeof data === "string" ? Buffer.from(data, "base64") : data;
    if (bytes.length === 0 || bytes.length > ASSISTANT_FILE_LIMITS.bytes)
      return yield* new AttachmentRejected({
        cause: "size",
        reason: "The generated image exceeds the supported size.",
      });
    if (sniffBinaryMediaType(bytes) !== mediaType)
      return yield* new AttachmentRejected({
        cause: "content",
        reason: "The generated image does not match its declared type.",
      });
    return bytes;
  });

/**
 * Blob candidate/write precede the fenced atomic registration + ref-only
 * event. The same path stores a model's image output and a tool's delivered
 * file; only the caller-supplied validation differs. `inTransaction` joins the
 * registration's transaction and returns storage keys to delete after commit.
 */
export const acceptGeneratedFile = (
  service: AttachmentService["Service"],
  input: {
    fence: GenerationIdentity;
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
    allowedKinds?: ReadonlyArray<AttachmentKind>;
    origin?: { toolCallId: string };
    /** Which bound it counts against; see `assistantFileSource`. */
    source: AssistantFileSource;
    /**
     * A slot the answer's image budget granted before the image was drawn. It
     * was counted then and paid for since, so only the byte ceilings apply.
     */
    reserved?: boolean;
    inTransaction?: (tx: DbTx) => Effect.Effect<ReadonlyArray<string>>;
    textOffset: number;
    turnIndex: number;
    eventIndex: number;
    callIndex: number;
    seq: number;
  },
) =>
  Effect.gen(function* () {
    let file: AssistantFile | undefined;
    let output: AssistantOutput | null = null;
    let previous: ReadonlyArray<AssistantFile> = [];
    let discard: ReadonlyArray<string> = [];
    yield* service.upload({
      userId: input.fence.userId,
      fileName: input.fileName,
      declaredMediaType: input.mediaType,
      bytes: input.bytes,
      ...(input.allowedKinds ? { allowedKinds: input.allowedKinds } : {}),
      association: {
        before: (tx) =>
          Effect.gen(function* () {
            output = yield* lockGenerationOutput(tx, input.fence);
            previous = output?.files ?? [];
            const image = isGeneratedImage(input.source);
            const sameKind = previous.filter(
              (item) => isGeneratedImage(assistantFileSource(item)) === image,
            );
            // The tool's images were counted against everything stored when their
            // slots were granted, so a model's own image competes only with its own:
            // in either order, both are kept.
            const counted =
              input.source === "native"
                ? sameKind.filter((item) => assistantFileSource(item) === "native")
                : sameKind;
            if (
              (!input.reserved &&
                counted.length >=
                  (image ? ASSISTANT_FILE_LIMITS.images : ASSISTANT_FILE_LIMITS.count)) ||
              (!image &&
                totalBytes(sameKind) + input.bytes.length > ASSISTANT_FILE_LIMITS.totalBytes) ||
              totalBytes(previous) + input.bytes.length > ASSISTANT_FILE_LIMITS.answerBytes
            )
              return yield* new AttachmentRejected({
                cause: "size",
                reason: image
                  ? "This answer already holds as many images as one message may carry."
                  : "This answer already holds as many files as one message may carry.",
              });
          }),
        after: (tx, attachment) =>
          Effect.gen(function* () {
            file = {
              v: 1,
              attachment,
              textOffset: input.textOffset,
              turnIndex: input.turnIndex,
              eventIndex: input.eventIndex,
              callIndex: input.callIndex,
              ...(input.origin ? { origin: input.origin } : {}),
              source: input.source,
            };
            yield* tx
              .insert(messageAttachments)
              .values({
                messageId: input.fence.messageId,
                attachmentId: attachment.id,
                position: yield* nextAttachmentPosition(tx, input.fence.messageId),
              })
              .pipe(Effect.orDie);
            yield* tx
              .update(messages)
              // Merged, never replaced: search images live in the same column.
              .set({ assistantOutput: { ...output, v: 1, files: [...previous, file] } })
              .where(eq(messages.id, input.fence.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .insert(messageChunks)
              .values({
                messageId: input.fence.messageId,
                seq: input.seq,
                kind: "file",
                delta: JSON.stringify(file),
              })
              .pipe(Effect.orDie);
            if (input.inTransaction) discard = yield* input.inTransaction(tx);
          }),
      },
    });
    if (!file) return yield* Effect.die(new Error("Generated file registration failed."));
    yield* service.deleteBlobs(discard);
    return file;
  });

/** A model's own image output: strict base64 in, sniffed image out, then the shared path. */
export const acceptGeneratedImage = (
  service: AttachmentService["Service"],
  input: {
    fence: GenerationIdentity;
    mediaType: string;
    data: string | Uint8Array;
    textOffset: number;
    turnIndex: number;
    eventIndex: number;
    callIndex: number;
    seq: number;
  },
) =>
  Effect.gen(function* () {
    const bytes = yield* decodeGeneratedImage(input.mediaType, input.data);
    return yield* acceptGeneratedFile(service, {
      ...input,
      fileName: `generated-${input.eventIndex + 1}.${input.mediaType.split("/")[1]}`,
      bytes,
      allowedKinds: ["image"],
      source: "native",
    });
  });

/** Bounds for the images ```ui blocks ask for, across every attempt of one answer. */
export const SEARCH_IMAGE_LIMITS = {
  count: 32,
  totalBytes: 16 * 1024 * 1024,
} as const;

/**
 * Stores one fetched search image and claims it for the answer, under the
 * generation fence. Bytes are stored as fetched; the browser decodes them.
 */
export const acceptSearchImage = (
  service: AttachmentService["Service"],
  input: { fence: GenerationIdentity; fileName: string; mediaType: string; bytes: Uint8Array },
) =>
  service.upload({
    userId: input.fence.userId,
    fileName: input.fileName,
    declaredMediaType: input.mediaType,
    bytes: input.bytes,
    allowedKinds: ["image"],
    association: {
      before: (tx) =>
        Effect.gen(function* () {
          yield* lockGeneration(tx, input.fence);
          const [held] = yield* tx
            .select({
              count: sql<number>`count(*)::int`,
              bytes: sql<number>`coalesce(sum(${attachmentBlobs.size}), 0)::bigint`,
            })
            .from(messageAttachments)
            .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
            .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
            .where(
              and(
                eq(messageAttachments.messageId, input.fence.messageId),
                eq(messageAttachments.kind, "search_image"),
              ),
            )
            .pipe(Effect.orDie);
          if (
            (held?.count ?? 0) >= SEARCH_IMAGE_LIMITS.count ||
            Number(held?.bytes ?? 0) + input.bytes.length > SEARCH_IMAGE_LIMITS.totalBytes
          )
            return yield* new AttachmentRejected({
              cause: "size",
              reason: "This answer already holds as many images as it may.",
            });
        }),
      after: (tx, attachment) =>
        Effect.gen(function* () {
          yield* tx
            .insert(messageAttachments)
            .values({
              messageId: input.fence.messageId,
              attachmentId: attachment.id,
              position: yield* nextAttachmentPosition(tx, input.fence.messageId),
              kind: "search_image",
            })
            .pipe(Effect.orDie);
        }),
    },
  });
