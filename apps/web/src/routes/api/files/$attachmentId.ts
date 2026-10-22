import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { fileResponse, holdsCurrent, notModified } from "~/server/file-response.ts";
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
        // An attachment's bytes and name never change, so its id tags them. The
        // prefix retires every kept copy if the way they are served changes.
        const etag = `"a1-${params.attachmentId}"`;
        const current = holdsCurrent(request, etag);
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const service = yield* AttachmentService;
            const input = { userId: session.user.id, attachmentId: params.attachmentId };
            // The access check runs either way; a kept copy only skips reading the bytes.
            if (current) {
              yield* service.open(input);
              return "current" as const;
            }
            return yield* service.read(input);
          }).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });
        if (file === "current") return notModified(etag);
        return fileResponse(
          { bytes: file.bytes, name: file.fileName, mediaType: file.mediaType },
          { inline: true, cache: { etag } },
        );
      },
    },
  },
});
