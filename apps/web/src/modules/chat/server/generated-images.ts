import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { messageAttachments, messageChunks, messages } from "~/db/schema/index.ts";
import { AttachmentRejected } from "~/modules/attachments/errors.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { IMAGE_MEDIA_TYPES } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType } from "~/modules/attachments/server/validation.ts";
import { type AssistantImage, IMAGE_OUTPUT_LIMITS } from "../assistant-output.ts";
import { lockGeneration, type GenerationIdentity } from "./generation-fence.ts";

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
      (data.length > Math.ceil(IMAGE_OUTPUT_LIMITS.bytes / 3) * 4 ||
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
    if (bytes.length === 0 || bytes.length > IMAGE_OUTPUT_LIMITS.bytes)
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

/** Blob candidate/write precede the fenced atomic registration + ref-only event. */
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
    let image: AssistantImage | undefined;
    let previous: ReadonlyArray<AssistantImage> = [];
    yield* service.upload({
      userId: input.fence.userId,
      fileName: `generated-${input.eventIndex + 1}.${input.mediaType.split("/")[1]}`,
      declaredMediaType: input.mediaType,
      bytes,
      allowedKinds: ["image"],
      association: {
        before: (tx) =>
          Effect.gen(function* () {
            const message = yield* lockGeneration(tx, input.fence);
            previous = message.assistantOutput?.images ?? [];
            if (
              previous.length >= IMAGE_OUTPUT_LIMITS.count ||
              previous.reduce((sum, item) => sum + item.attachment.size, 0) + bytes.length >
                IMAGE_OUTPUT_LIMITS.totalBytes
            )
              return yield* Effect.die(new Error("Generated images exceed the per-message limit."));
          }),
        after: (tx, attachment) =>
          Effect.gen(function* () {
            image = {
              v: 1,
              attachment,
              textOffset: input.textOffset,
              turnIndex: input.turnIndex,
              eventIndex: input.eventIndex,
              callIndex: input.callIndex,
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
              .set({ assistantOutput: { v: 1, images: [...previous, image] } })
              .where(eq(messages.id, input.fence.messageId))
              .pipe(Effect.orDie);
            yield* tx
              .insert(messageChunks)
              .values({
                messageId: input.fence.messageId,
                seq: input.seq,
                kind: "image",
                delta: JSON.stringify(image),
              })
              .pipe(Effect.orDie);
          }),
      },
    });
    if (!image) return yield* Effect.die(new Error("Generated image registration failed."));
    return image;
  });
