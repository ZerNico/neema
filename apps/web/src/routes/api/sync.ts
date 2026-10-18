import { createFileRoute } from "@tanstack/react-router";
import { Effect, Stream } from "effect";
import { sessionEnded } from "~/modules/auth/server/account-eligibility.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { runtime } from "~/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";

/**
 * Per-tab sync feed: pushes this user's domain events (from any browser or
 * instance) so sidebars and open chats stay consistent.
 */
export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const stream = await runtime.runPromise(
          Effect.gen(function* () {
            const bus = yield* SyncBus;
            const ended = yield* sessionEnded(session.session.id, session.user.id);
            return bus.subscribe(session.user.id).pipe(Stream.interruptWhen(ended));
          }),
        );

        return sseResponse(stream, (event) => sseFrame("sync", event));
      },
    },
  },
});
