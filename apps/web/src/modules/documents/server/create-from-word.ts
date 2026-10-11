import { Effect, Option } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { DocumentRejected } from "../schema.ts";
import { DocumentService, type DocumentWriteGuard } from "./document-service.ts";
import { readWordDocument, titleFromFile } from "./word-import.ts";

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
  const read = yield* readWordDocument(input.file, Option.getOrNull(word), userId, (image) =>
    attachments
      .upload({
        userId,
        fileName: image.name,
        declaredMediaType: image.mediaType,
        bytes: image.bytes,
        allowedKinds: ["image"],
      })
      .pipe(Effect.map((attachment) => attachment.id)),
  ).pipe(Effect.mapError((reason) => new DocumentRejected({ reason })));
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
