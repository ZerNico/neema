import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { runtime } from "~/server/runtime.ts";

export const Route = createFileRoute("/api/knowledge/$collectionId/$documentId/$versionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const current = await sessionFromHeaders(request.headers);
        // An account still waiting on approval is declined here as though
        // signed out: only a server function can say why, and the browser
        // is already being sent to the waiting screen by the app route.
        if (!current?.approved) return new Response("Unauthorized", { status: 401 });
        const session = current.session;
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
        const fallback = file.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
        return new Response(file.bytes as BodyInit, {
          headers: {
            "Content-Type": file.mediaType,
            "Content-Length": String(file.bytes.byteLength),
            "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            // Source access is revocable: immutable versions must not imply an
            // immutable permission decision in the browser or a shared cache.
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
