import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { MachineChats } from "@chat/desktop-rpc";
import { badRequest, machineRequest } from "~/modules/computer/server/machine-route.ts";
import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

const decode = Schema.decodeUnknownOption(MachineChats);

/**
 * The machine's chats that were purged while it was offline. The purge's discard is sent once,
 * so this is how a machine that missed it finds out what to remove.
 */
export const Route = createFileRoute("/api/machine/gone")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const machine = await machineRequest(request);
        if (!machine) return unauthorized();
        const body = decode(await request.json().catch(() => null));
        if (body._tag !== "Some") return badRequest();
        const gone = await runtime.runPromise(
          Effect.flatMap(ComputerRepo, (repo) => repo.gone(body.value.conversationIds)),
        );
        return Response.json({ conversationIds: gone });
      },
    },
  },
});
