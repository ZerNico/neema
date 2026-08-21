import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { auth } from "~/modules/auth/server/auth.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";

// Resumable message stream: replays persisted chunks after ?after=<seq>,
// then tails live generation, then emits a terminal `done` event.
export const Route = createFileRoute("/api/messages/$messageId/stream")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });

        const url = new URL(request.url);
        const after = Number(url.searchParams.get("after") ?? "0");
        const afterSeq = Number.isFinite(after) && after >= 0 ? after : 0;

        const stream = await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* ChatRepo;
            const engine = yield* StreamEngine;

            const message = yield* repo.getMessage(params.messageId);
            if (!message) return null;
            // Ownership check: the conversation must belong to the caller.
            yield* repo.getConversation(session.user.id, message.conversationId);

            return engine.subscribe(params.messageId, afterSeq);
          }).pipe(Effect.catchTag("ConversationNotFound", () => Effect.succeed(null))),
        );

        if (!stream) return new Response("Not found", { status: 404 });

        return sseResponse(stream, (event) =>
          event.kind === "chunk"
            ? sseFrame("chunk", { seq: event.seq, delta: event.delta })
            : sseFrame("done", { status: event.status }),
        );
      },
    },
  },
});
