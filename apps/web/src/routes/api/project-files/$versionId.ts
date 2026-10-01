import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * One version of a project file, for any member of its project. Always a
 * download: these are working files to open elsewhere, never pages to render.
 */
export const Route = createFileRoute("/api/project-files/$versionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const file = await runtime.runPromise(
          Effect.flatMap(ProjectFileService, (service) =>
            service.download(session.user.id, params.versionId),
          ),
        );
        if (!file) return new Response("Not found", { status: 404 });
        // Access can be taken away, so nothing is cached.
        return fileResponse(file, { cache: "revocable" });
      },
    },
  },
});
