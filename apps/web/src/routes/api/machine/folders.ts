import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { MachineFolders } from "@chat/desktop-rpc";
import { badRequest, machineRequest } from "~/modules/computer/server/machine-route.ts";
import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

const decode = Schema.decodeUnknownOption(MachineFolders);

/** A chat's attached folders changed on its machine: the names, for the hint and the chip. */
export const Route = createFileRoute("/api/machine/folders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const machine = await machineRequest(request);
        if (!machine) return unauthorized();
        const body = decode(await request.json().catch(() => null));
        if (body._tag !== "Some") return badRequest();
        const saved = await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* ComputerRepo;
            const ok = yield* repo.setFolders(
              machine.userId,
              machine.hello.machineId,
              body.value.conversationId,
              body.value.folders,
            );
            if (ok) {
              const bus = yield* SyncBus;
              yield* bus.publish(machine.userId, { type: "computer.changed" });
              // A first folder may have bound the chat to this machine.
              yield* bus.publish(machine.userId, {
                type: "conversation.updated",
                conversationId: body.value.conversationId,
              });
            }
            return ok;
          }),
        );
        return Response.json({ saved });
      },
    },
  },
});
