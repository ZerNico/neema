import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { ComputerCalls } from "~/modules/computer/server/calls.ts";
import { MachineHub } from "~/modules/computer/server/hub.ts";
import { machineRequest } from "~/modules/computer/server/machine-route.ts";
import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

/** A connected machine's new hello: its image finished downloading, remote control changed. */
export const Route = createFileRoute("/api/machine/status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const machine = await machineRequest(request);
        if (!machine) return unauthorized();
        const connected = await runtime.runPromise(
          Effect.gen(function* () {
            yield* (yield* ComputerRepo).saveMachine(machine.userId, machine.hello);
            const connected = yield* (yield* MachineHub).update(machine.userId, machine.hello);
            // Calls held while it downloaded its environment run once it is ready.
            yield* (yield* ComputerCalls).machineChanged(machine.userId, machine.hello.machineId);
            return connected;
          }),
        );
        return Response.json({ connected });
      },
    },
  },
});
