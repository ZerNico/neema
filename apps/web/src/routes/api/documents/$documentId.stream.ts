import { createFileRoute } from "@tanstack/react-router";
import { Effect, Stream } from "effect";
import { fromBase64 } from "lib0/buffer";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

const stateVector = (value: string | null) => {
  if (!value) return null;
  try {
    return fromBase64(value);
  } catch {
    return null;
  }
};

/**
 * One open document editor's live feed: a `sync` diff against `?sv=`, then
 * every later Yjs batch and cursor change. `?client=` is the editor's Y.Doc
 * client id, so its own batches are not echoed back and its cursor leaves
 * with the connection.
 */
export const Route = createFileRoute("/api/documents/$documentId/stream")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const url = new URL(request.url);
        const client = Number(url.searchParams.get("client"));
        const stream = await runtime.runPromise(
          Effect.flatMap(DocumentService, (service) =>
            service.subscribe(session.user.id, params.documentId, {
              stateVector: stateVector(url.searchParams.get("sv")),
              clientId: Number.isSafeInteger(client) && client >= 0 ? client : null,
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
