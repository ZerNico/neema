import { createFileRoute } from "@tanstack/react-router";
import { openMessageStream } from "~/modules/chat/server/message-stream.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * Resumable message stream: replays persisted chunks after ?after=<seq>,
 * then tails live generation, then emits a terminal `done` event.
 */
export const Route = createFileRoute("/api/messages/$messageId/stream")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const url = new URL(request.url);
        const after = Number(url.searchParams.get("after") ?? "0");
        const afterSeq = Number.isFinite(after) && after >= 0 ? after : 0;

        const stream = await runtime.runPromise(
          openMessageStream({
            userId: session.user.id,
            sessionId: session.session.id,
            messageId: params.messageId,
            afterSeq,
            runId: url.searchParams.get("runId") ?? undefined,
          }),
        );

        if (!stream) return new Response("Not found", { status: 404 });

        return sseResponse(stream, (event) =>
          event.kind === "status"
            ? sseFrame("status", {
                reading: event.reading,
                ...(event.runId ? { runId: event.runId } : {}),
              })
            : event.kind === "chunk"
              ? sseFrame("chunk", {
                  seq: event.seq,
                  kind: event.chunkKind,
                  delta: event.delta,
                  // A replayed tool call keeps its own start, so a reload's clock agrees.
                  at: event.at ?? Date.now(),
                  // The server's clock now, so the client can read `at` against it.
                  sentAt: Date.now(),
                  ...(event.runId ? { runId: event.runId } : {}),
                })
              : event.kind === "lookups"
                ? sseFrame("lookups", {
                    lookups: event.lookups,
                    ...(event.runId ? { runId: event.runId } : {}),
                  })
                : event.kind === "preview"
                  ? sseFrame("preview", {
                      callId: event.callId,
                      mediaType: event.mediaType,
                      data: event.data,
                      ...(event.runId ? { runId: event.runId } : {}),
                    })
                  : sseFrame("done", {
                      status: event.status,
                      ...(event.runId ? { runId: event.runId } : {}),
                    }),
        );
      },
    },
  },
});
