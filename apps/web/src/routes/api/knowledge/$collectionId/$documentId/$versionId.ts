import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

export const Route = createFileRoute("/api/knowledge/$collectionId/$documentId/$versionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const file = await runtime.runPromise(
          Effect.flatMap(KnowledgeService, (service) =>
            service.download(session.user.id, params),
          ).pipe(Effect.catchTag("KnowledgeNotAvailable", () => Effect.succeed(null))),
        );
        if (!file)
          return new Response("Not found", {
            status: 404,
            headers: { "Cache-Control": "no-store" },
          });
        // Source access is revocable: immutable versions must not imply an
        // immutable permission decision in the browser or a shared cache.
        return fileResponse(
          { bytes: file.bytes, name: file.fileName, mediaType: file.mediaType },
          { cache: "never" },
        );
      },
    },
  },
});
