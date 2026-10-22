import { Effect, Schema } from "effect";
import {
  GENERIC_MEDIA_TYPE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";
import { AttachmentRejected } from "~/modules/attachments/errors.ts";
import { withoutImageMetadata } from "~/modules/attachments/image-metadata.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";

/**
 * What all of one send's files may weigh, decoded. One file as large as the
 * app takes, so a request stays a size a client sends in one piece.
 */
export const MAX_FILES_BYTES = MAX_ATTACHMENT_BYTES;

/** The request body, which the server caps before reading: the files as base64, and room for the rest. */
export const MAX_REQUEST_BYTES = Math.ceil((MAX_FILES_BYTES * 4) / 3) + 1024 * 1024;

export const FileInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mediaType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
  /** The bytes, base64-encoded. */
  data: Schema.String,
});
export type FileInput = typeof FileInput.Type;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded size, read from the text alone: nothing is decoded that would be refused. */
const decodedSize = (data: string) =>
  (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** Why these files can't be sent, before anything is decoded; null when they can. */
export const checkFiles = (files: ReadonlyArray<FileInput>) => {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE)
    return `Send at most ${MAX_ATTACHMENTS_PER_MESSAGE} files with one message.`;
  let total = 0;
  for (const file of files) {
    if (file.data.length % 4 !== 0 || !BASE64.test(file.data))
      return `${file.name} isn't base64. Send each file's bytes base64-encoded in data.`;
    const size = decodedSize(file.data);
    if (size === 0) return `${file.name} is empty.`;
    if (size > MAX_ATTACHMENT_BYTES)
      return `${file.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
    total += size;
  }
  if (total > MAX_FILES_BYTES)
    return `These files come to more than ${MAX_FILES_BYTES / 1024 / 1024} MB; send fewer at once.`;
  return null;
};

/**
 * Stores each file as the composer's upload does, typed by its bytes rather
 * than the name it came with. An unsent upload is the person's like one left
 * in the composer, and swept as one.
 */
export const uploadFiles = Effect.fn("mcp.uploadFiles")(function* (
  userId: string,
  files: ReadonlyArray<FileInput>,
) {
  // The feature governs what a person uploads, wherever from.
  if (!(yield* FeaturePolicy.use((policy) => policy.can(userId, "attachments"))))
    return yield* new AttachmentRejected({ cause: "type", reason: "files are unavailable" });
  const attachments = yield* AttachmentService;
  // What a person sends keeps the picture, not where and when it was taken.
  const sent = files.map((file) => ({
    file,
    bytes: withoutImageMetadata(Buffer.from(file.data, "base64")),
  }));
  yield* StorageQuota.use((quota) =>
    quota.admit(
      userId,
      sent.map(({ bytes }) => bytes),
    ),
  );
  const ids: string[] = [];
  const upload = Effect.forEach(sent, ({ file, bytes }) =>
    attachments
      .upload({
        userId,
        fileName: file.name,
        declaredMediaType: file.mediaType ?? GENERIC_MEDIA_TYPE,
        bytes,
      })
      .pipe(Effect.tap((stored) => Effect.sync(() => ids.push(stored.id)))),
  );
  // One refused file sends none: those stored before it go too.
  yield* upload.pipe(Effect.onError(() => removeFiles(userId, ids)));
  return ids;
});

/** Uploads made for a send that never happened, removed as a closed composer's would be. */
export const removeFiles = (userId: string, ids: ReadonlyArray<string>) =>
  Effect.forEach(
    ids,
    (attachmentId) =>
      Effect.flatMap(AttachmentService, (attachments) =>
        attachments.remove({ userId, attachmentId }),
      ).pipe(Effect.ignore),
    { discard: true },
  );
