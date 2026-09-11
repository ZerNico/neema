import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";

// Per-tab sync feed: pushes this user's domain events (from any browser or
// instance) so sidebars and open chats stay consistent.
export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const current = await sessionFromHeaders(request.headers);
        // An account still waiting on approval is declined here as though
        // signed out: only a server function can say why, and the browser
        // is already being sent to the waiting screen by the app route.
        if (!current?.approved) return new Response("Unauthorized", { status: 401 });
        const session = current.session;

        const stream = await runtime.runPromise(
          Effect.map(SyncBus, (bus) => bus.subscribe(session.user.id)),
        );

        return sseResponse(stream, (event) => sseFrame("sync", event));
      },
    },
  },
});
