import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { runtime } from "~/server/runtime.ts";
import { DesktopToolResult } from "../tool-schema.ts";

const standard = Schema.toStandardSchemaV1;

export const SubmitDesktopToolResultInput = Schema.Struct({
  conversationId: Schema.String.check(Schema.isMinLength(1)),
  /** The durable `message_tool_calls` row id the start envelope carried. */
  callId: Schema.String.check(Schema.isMinLength(1)),
  result: DesktopToolResult,
});

/**
 * Where a tool that ran on the user's machine reports back.
 *
 * The waiting handler is keyed by call id alone, so ownership is checked here
 * rather than taken on trust: a signed-in user must own the conversation the
 * call belongs to before their answer is allowed to unblock it.
 *
 * `accepted: false` is an ordinary outcome, not an error. By the time an answer
 * arrives the generation may have been stopped, timed out or failed, and the
 * registration is gone with it. Refusing loudly would turn a race the design
 * expects into a visible failure.
 */
export const submitDesktopToolResult = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SubmitDesktopToolResultInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const conversation = yield* repo.getConversation(
          context.session.user.id,
          data.conversationId,
        );
        if (!conversation) return { accepted: false as const };
        const external = yield* ExternalCompletion;
        const accepted = yield* external.complete(data.callId, data.result);
        return { accepted };
      }),
    ),
  );
