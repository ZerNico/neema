import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { auth } from "~/modules/auth/server/auth.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";

// Per-tab sync feed: pushes this user's domain events (from any browser or
// instance) so sidebars and open chats stay consistent.
export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });

        const stream = await runtime.runPromise(
          SyncBus.useSync((bus) => bus.subscribe(session.user.id)),
        );

        return sseResponse(stream, (event) => sseFrame("sync", event));
      },
    },
  },
});
