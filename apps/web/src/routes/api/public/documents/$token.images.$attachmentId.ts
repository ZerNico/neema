import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * An image of a document with a public link, to anyone holding the link,
 * only while it still opens the document. Only images that document claimed.
 */
export const Route = createFileRoute("/api/public/documents/$token/images/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const documents = yield* DocumentService;
            const documentId = yield* documents.publicDocumentId(params.token);
            if (!documentId) return null;
            const attachments = yield* AttachmentService;
            return yield* attachments.readDocumentImage({
              documentId,
              attachmentId: params.attachmentId,
            });
          }).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });
        // Turning the link off must stop the image too, so nothing keeps a copy.
        return fileResponse(
          { bytes: file.bytes, name: file.fileName, mediaType: file.mediaType },
          { inline: true, cache: "never" },
        );
      },
    },
  },
});
