import { createFileRoute } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { ToolResult } from "@chat/desktop-rpc";
import { ComputerCalls } from "~/modules/computer/server/calls.ts";
import { badRequest, machineRequest } from "~/modules/computer/server/machine-route.ts";
import { acceptDesktopToolResult } from "~/modules/desktop/server/result.ts";
import { unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

const decode = Schema.decodeUnknownOption(ToolResult);

/** A machine's answer to a call it was sent. Capped and classified like any untrusted result. */
export const Route = createFileRoute("/api/machine/calls/$callId/result")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const machine = await machineRequest(request);
        if (!machine) return unauthorized();
        const result = decode(await request.json().catch(() => null));
        if (result._tag !== "Some") return badRequest();
        const accepted = await runtime.runPromise(
          Effect.gen(function* () {
            const calls = yield* ComputerCalls;
            return yield* calls.result(
              machine.userId,
              machine.hello.machineId,
              params.callId,
              acceptDesktopToolResult(result.value),
            );
          }),
        );
        return Response.json({ accepted });
      },
    },
  },
});
