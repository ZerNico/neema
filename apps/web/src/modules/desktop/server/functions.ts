import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { runtime } from "~/server/runtime.ts";
import { DesktopToolResult } from "../tool-schema.ts";

const standard = Schema.toStandardSchemaV1;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const ownerFields = { conversationId: Id, messageId: Id, generationId: Id, executorId: Id };
const CallInput = Schema.Struct({ ...ownerFields, callId: Id });
export const SubmitDesktopToolResultInput = Schema.Struct({
  ...ownerFields,
  callId: Id,
  token: Id,
  result: DesktopToolResult,
});

export const desktopWorkSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ executorId: Id })))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const external = yield* ExternalCompletion;
        const repo = yield* ChatRepo;
        const userId = context.session.user.id;
        const snapshot = yield* external.snapshot(userId, data.executorId);
        for (const attempt of snapshot.attempts) {
          if (!(yield* repo.isDesktopAttemptLive(attempt))) yield* external.cancelAttempt(attempt);
        }
        const live = yield* external.snapshot(userId, data.executorId);
        const settings = [];
        for (const conversationId of new Set(live.attempts.map((a) => a.conversationId))) {
          const conversation = yield* repo.getConversation(userId, conversationId);
          if (conversation)
            settings.push({
              conversationId,
              title: conversation.title,
              approval: conversation.permissionLevel,
              network: conversation.networkLevel,
            });
        }
        return {
          ...live,
          calls: live.calls.map((call) => ({ ...call, args: JSON.stringify(call.args) })),
          settings,
        };
      }),
    ),
  );

export const claimDesktopTool = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CallInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const external = yield* ExternalCompletion;
        const repo = yield* ChatRepo;
        const owner = { ...data, userId: context.session.user.id };
        if (!(yield* repo.isDesktopAttemptLive(owner))) return { token: null };
        return { token: yield* external.claim(data.callId, owner) };
      }),
    ),
  );

// The in-process claim is rechecked after the database read. A late answer is
// refused even if the generation was live when the request first arrived.
export const submitDesktopToolResult = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SubmitDesktopToolResultInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const external = yield* ExternalCompletion;
        const owner = { ...data, userId: context.session.user.id };
        if (!(yield* repo.isDesktopAttemptLive(owner))) return { accepted: false };
        return {
          accepted: yield* external.completeClaim(data.callId, owner, data.token, data.result),
        };
      }),
    ),
  );
