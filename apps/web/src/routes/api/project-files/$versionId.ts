import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { runtime } from "~/server/runtime.ts";

const contentDisposition = (fileName: string) => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

/**
 * One version of a project file, for any member of its project. Always a
 * download: these are working files to open elsewhere, never pages to render.
 */
export const Route = createFileRoute("/api/project-files/$versionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const current = await sessionFromHeaders(request.headers);
        if (!current?.approved) return new Response("Unauthorized", { status: 401 });
        const file = await runtime.runPromise(
          Effect.flatMap(ProjectFileService, (service) =>
            service.download(current.session.user.id, params.versionId),
          ),
        );
        if (!file) return new Response("Not found", { status: 404 });
        return new Response(file.bytes as BodyInit, {
          headers: {
            "Content-Type": file.mediaType,
            "Content-Length": String(file.bytes.byteLength),
            "Content-Disposition": contentDisposition(file.name),
            // Access can be taken away, so nothing is cached for long.
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
