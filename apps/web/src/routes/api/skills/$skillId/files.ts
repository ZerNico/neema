import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { SkillService } from "~/modules/skills/server/service.ts";
import { fileResponse } from "~/server/file-response.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * A binary file of a skill, by content hash, for its owner's editor: download
 * and ZIP export. Always a download: a skill file never renders on this origin.
 */
export const Route = createFileRoute("/api/skills/$skillId/files")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const sha256 = new URL(request.url).searchParams.get("sha256") ?? "";
        if (!/^[0-9a-f]{64}$/.test(sha256)) return new Response("Invalid file", { status: 400 });
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const service = yield* SkillService;
            return yield* service.readFile(session.user.id, params.skillId, sha256);
          }).pipe(Effect.catchTag("SkillNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });
        // The current revision moves on every save.
        return fileResponse(
          {
            bytes: file.bytes,
            name: file.path.slice(file.path.lastIndexOf("/") + 1),
            mediaType: file.mediaType,
          },
          { cache: "never" },
        );
      },
    },
  },
});
