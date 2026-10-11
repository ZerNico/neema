import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * An image a document claimed, to anyone who may read that document. Raw
 * route rather than a server function because the body is bytes.
 */
export const Route = createFileRoute("/api/documents/$documentId/images/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const documents = yield* DocumentService;
            const document = yield* documents.get(session.user.id, params.documentId);
            if (!document) return null;
            const attachments = yield* AttachmentService;
            return yield* attachments.readDocumentImage({
              documentId: document.id,
              attachmentId: params.attachmentId,
            });
          }).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });

        // Project membership can be taken away, so neither the browser nor
        // anything shared may keep a copy past this response.
        return fileResponse(
          { bytes: file.bytes, name: file.fileName, mediaType: file.mediaType },
          { inline: true, cache: "revocable" },
        );
      },
    },
  },
});
