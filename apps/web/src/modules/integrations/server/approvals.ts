import { Context, Deferred, Duration, Effect, Layer } from "effect";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { PendingIntegrationCall } from "../schema.ts";

export type ApprovalAnswer = "allow" | "deny" | "timeout";

/** Reads wait less: a person approving every lookup is at the keyboard anyway. */
export const APPROVAL_TIMEOUTS = {
  read: Duration.minutes(2),
  change: Duration.minutes(10),
} as const;

interface Waiting {
  readonly userId: string;
  readonly call: PendingIntegrationCall;
  readonly answer: Deferred.Deferred<"allow" | "deny">;
}

/**
 * Integration calls parked on a person's decision. The handler owns the wait:
 * Stop, lease loss or the generation ending interrupt it, and its finalizer
 * removes the entry, so a late Allow finds nothing to approve. In memory like
 * `ExternalCompletion`; a restart ends the generation and its waits with it.
 */
export class IntegrationApprovals extends Context.Service<
  IntegrationApprovals,
  {
    request(
      userId: string,
      call: Omit<PendingIntegrationCall, "expiresAt">,
    ): Effect.Effect<ApprovalAnswer>;
    /** False when there is no such waiting call for this person any more. */
    decide(userId: string, callId: string, answer: "allow" | "deny"): Effect.Effect<boolean>;
    get(userId: string, callId: string): Effect.Effect<PendingIntegrationCall | null>;
    pending(userId: string): Effect.Effect<ReadonlyArray<PendingIntegrationCall>>;
  }
>()("chat/integrations/IntegrationApprovals") {
  static readonly layer = Layer.effect(
    IntegrationApprovals,
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const waiting = new Map<string, Waiting>();
      const announce = (userId: string, conversationId: string) =>
        bus
          .publish(userId, { type: "integration.approval.changed", conversationId })
          .pipe(Effect.catchCause(() => Effect.void));

      return IntegrationApprovals.of({
        request: Effect.fn("IntegrationApprovals.request")(function* (userId, call) {
          const timeout =
            call.access === "read" ? APPROVAL_TIMEOUTS.read : APPROVAL_TIMEOUTS.change;
          const answer = yield* Deferred.make<"allow" | "deny">();
          const entry: Waiting = {
            userId,
            call: { ...call, expiresAt: Date.now() + Duration.toMillis(timeout) },
            answer,
          };
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => waiting.set(call.callId, entry)).pipe(
              Effect.andThen(announce(userId, call.conversationId)),
            ),
            () =>
              Deferred.await(answer).pipe(
                Effect.timeoutOption(timeout),
                Effect.map((decided) =>
                  decided._tag === "Some" ? decided.value : ("timeout" as const),
                ),
              ),
            () =>
              Effect.sync(() => waiting.delete(call.callId)).pipe(
                Effect.andThen(announce(userId, call.conversationId)),
              ),
          );
        }),

        decide: Effect.fn("IntegrationApprovals.decide")(function* (userId, callId, answer) {
          const entry = waiting.get(callId);
          if (!entry || entry.userId !== userId) return false;
          return yield* Deferred.succeed(entry.answer, answer);
        }),

        get: (userId, callId) =>
          Effect.sync(() => {
            const entry = waiting.get(callId);
            return entry && entry.userId === userId ? entry.call : null;
          }),

        pending: (userId) =>
          Effect.sync(() =>
            [...waiting.values()]
              .filter((entry) => entry.userId === userId)
              .map((entry) => entry.call),
          ),
      });
    }),
  );
}
