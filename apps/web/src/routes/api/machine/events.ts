import { createFileRoute } from "@tanstack/react-router";
import { Effect, Stream } from "effect";
import { sessionEnded } from "~/modules/auth/server/account-eligibility.ts";
import { ComputerCalls } from "~/modules/computer/server/calls.ts";
import { MachineHub } from "~/modules/computer/server/hub.ts";
import { machineRequest } from "~/modules/computer/server/machine-route.ts";
import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { sseFrame, sseResponse } from "~/modules/sync/server/sse.ts";
import { unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * A machine's one stream: open while the desktop app runs, it is what makes the machine online.
 * Calls, cancels, grants and agent chats arrive here; see docs/internals/desktop.md.
 */
export const Route = createFileRoute("/api/machine/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const machine = await machineRequest(request);
        if (!machine) return unauthorized();
        const { userId, hello, session } = machine;
        const stream = await runtime.runPromise(
          Effect.gen(function* () {
            const ended = yield* sessionEnded(session.session.id, userId);
            const repo = yield* ComputerRepo;
            const hub = yield* MachineHub;
            const calls = yield* ComputerCalls;
            // Shown by the person's own name for it when they set one.
            const shown = { ...hello, name: yield* repo.saveMachine(userId, hello) };
            return Stream.unwrap(
              Effect.gen(function* () {
                const events = yield* hub.connect(userId, shown, session.session.id);
                yield* Effect.addFinalizer(() => repo.touchMachine(userId, hello.machineId));
                yield* calls.pushPolicy(userId, hello.machineId);
                yield* calls.machineConnected(userId, hello.machineId);
                return events;
              }),
            ).pipe(Stream.interruptWhen(ended));
          }),
        );
        return sseResponse(stream, (event) => sseFrame("machine", event));
      },
    },
  },
});
