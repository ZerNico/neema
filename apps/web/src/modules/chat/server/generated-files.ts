import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { messageAttachments, messageChunks, messages } from "~/db/schema/index.ts";
import { AttachmentRejected } from "~/modules/attachments/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { IMAGE_MEDIA_TYPES, type AttachmentKind } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType } from "~/modules/attachments/server/validation.ts";
import { type AssistantFile, ASSISTANT_FILE_LIMITS } from "../assistant-output.ts";
import { lockGeneration, type GenerationIdentity } from "./generation-fence.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";

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
            const message = yield* lockGeneration(tx, input.fence);
            previous = message.assistantOutput?.files ?? [];
            if (
              previous.length >= ASSISTANT_FILE_LIMITS.count ||
              previous.reduce((sum, item) => sum + item.attachment.size, 0) + input.bytes.length >
                ASSISTANT_FILE_LIMITS.totalBytes
            )
              return yield* new AttachmentRejected({
                cause: "size",
                reason: "This answer already holds as many files as one message may carry.",
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
            };
            yield* tx
              .insert(messageAttachments)
              .values({
                messageId: input.fence.messageId,
                attachmentId: attachment.id,
                position: previous.length,
              })
              .pipe(Effect.orDie);
            yield* tx
              .update(messages)
              .set({ assistantOutput: { v: 1, files: [...previous, file] } })
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
    });
  });
