import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { approvalEvents } from "~/modules/auth/server/approval-events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";

export const Route = createFileRoute("/api/approval")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const current = await sessionFromHeaders(request.headers);
        if (!current) return new Response("Unauthorized", { status: 401 });
        const stream = await runtime.runPromise(
          Effect.map(SyncBus, (bus) => approvalEvents(bus, current.session.user.id)),
        );
        return sseResponse(stream, () => sseFrame("approval", null));
      },
    },
  },
});
