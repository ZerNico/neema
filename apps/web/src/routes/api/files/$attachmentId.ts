import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * Serves attachment bytes to anyone the access policy allows. Raw route rather
 * than a server function because the body is bytes with cache headers.
 */
export const Route = createFileRoute("/api/files/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const service = yield* AttachmentService;
            return yield* service.read({
              userId: session.user.id,
              attachmentId: params.attachmentId,
            });
          }).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });

        // Access is the owner's, or the owner's conversation's, and never
        // revoked while the file exists; its id never names other bytes.
        return fileResponse(
          { bytes: file.bytes, name: file.fileName, mediaType: file.mediaType },
          { inline: true, cache: "immutable" },
        );
      },
    },
  },
});
