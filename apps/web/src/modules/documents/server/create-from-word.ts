import { Effect, Option } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { DocumentRejected } from "../schema.ts";
import { DocumentService, type DocumentWriteGuard } from "./document-service.ts";
import { readWordDocument, titleFromFile } from "./word-import.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";

/**
 * A new project or chat document started from a Word file a person gave:
 * read in a Word worker, its pictures stored as the person's uploads and
 * claimed by the document, its comments as threads of origin `file`.
 */
export const createFromWord = Effect.fn("documents.createFromWord")(function* (
  userId: string,
  input: {
    readonly owner: { projectId: string } | { conversationId: string; createdByMessageId: string };
    readonly title?: string | undefined;
    readonly by: "user" | "model";
    readonly file: {
      readonly name: string;
      readonly mediaType: string;
      readonly bytes: Uint8Array;
    };
  },
  guard?: DocumentWriteGuard,
) {
  const word = yield* Effect.serviceOption(WordProcessor);
  const attachments = yield* AttachmentService;
  const storage = yield* StorageQuota;
  // A picture the import may not store is dropped quietly by the reader, but a person's full
  // storage is theirs to hear: it fails the import with the reason. The model's are kept.
  let full: string | null = null;
  const read = yield* readWordDocument(input.file, Option.getOrNull(word), userId, (image) =>
    (input.by === "user" ? storage.admit(userId, [image.bytes]) : Effect.void).pipe(
      // Its pictures are the uploader's files while it is read, like any they add.
      Effect.tapError((refused) => Effect.sync(() => (full ??= refused.reason))),
      Effect.andThen(
        attachments.upload({
          userId,
          fileName: image.name,
          declaredMediaType: image.mediaType,
          bytes: image.bytes,
          allowedKinds: ["image"],
        }),
      ),
      Effect.map((attachment) => attachment.id),
    ),
  ).pipe(Effect.mapError((reason) => new DocumentRejected({ reason })));
  if (full !== null) return yield* new DocumentRejected({ reason: full });
  const title = input.title?.trim() || read.title || titleFromFile(read.name);
  const created = yield* DocumentService.use((service) =>
    service.create(
      userId,
      { ...input.owner, title, content: "", by: input.by },
      guard,
      read.imported,
    ),
  );
  return { document: created.document, dropped: read.dropped };
});
