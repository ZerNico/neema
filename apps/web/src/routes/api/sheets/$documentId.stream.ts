import { createFileRoute } from "@tanstack/react-router";
import { Effect, Stream } from "effect";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

const revisionParam = (value: string | null) => {
  const revision = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
};
const clientParam = (value: string | null) => (value && value.length <= 64 ? value : null);

/**
 * One open sheet's live feed: the changes since `?revision=` (or the whole
 * document when that is too old or absent), then every later change and
 * cursor. `?client=` keeps the editor's own cursor from being echoed back
 * and tells a reset which of its changes are in.
 */
export const Route = createFileRoute("/api/sheets/$documentId/stream")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const url = new URL(request.url);
        const stream = await runtime.runPromise(
          Effect.flatMap(SheetService, (service) =>
            service.subscribe(session.user.id, params.documentId, {
              sessionId: session.session.id,
              revision: revisionParam(url.searchParams.get("revision")),
              clientId: clientParam(url.searchParams.get("client")),
            }),
          ),
        );
        if (!stream) return new Response("Not found", { status: 404 });
        return sseResponse(
          stream.pipe(Stream.takeUntil((frame) => frame.type === "gone")),
          (frame) => sseFrame(frame.type, frame),
        );
      },
    },
  },
});
