import { Context, Deferred, Duration, Effect, Layer } from "effect";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { ElicitationAnswer, PendingIntegrationCall } from "../schema.ts";

export type ApprovalAnswer = "allow" | "deny" | "timeout";

/** Reads wait less: a person approving every lookup is at the keyboard anyway. */
export const APPROVAL_TIMEOUTS = {
  read: Duration.minutes(2),
  change: Duration.minutes(10),
  /** Inside the MCP request's own five minutes, so the server is still listening. */
  elicitation: Duration.minutes(4),
} as const;

type Answer =
  | { readonly kind: "decision"; readonly value: "allow" | "deny" }
  | { readonly kind: "elicitation"; readonly value: ElicitationAnswer };

interface Waiting {
  readonly userId: string;
  readonly call: PendingIntegrationCall;
  readonly answer: Deferred.Deferred<Answer>;
}

type Pending = Omit<PendingIntegrationCall, "expiresAt" | "kind">;

/**
 * Integration calls parked on a person: an approval before a call runs, or a
 * service's question while it runs. The handler owns the wait: Stop, lease
 * loss or the generation ending interrupt it, and its finalizer removes the
 * entry, so a late answer finds nothing. In memory like `ExternalCompletion`;
 * a restart ends the generation and its waits with it.
 */
export class IntegrationApprovals extends Context.Service<
  IntegrationApprovals,
  {
    request(userId: string, call: Pending): Effect.Effect<ApprovalAnswer>;
    /** Asks the person on a service's behalf; no answer in time cancels. */
    elicit(
      userId: string,
      call: Pending & { prompt: NonNullable<PendingIntegrationCall["prompt"]> },
    ): Effect.Effect<ElicitationAnswer>;
    /** False when there is no such waiting call for this person any more. */
    decide(userId: string, callId: string, answer: "allow" | "deny"): Effect.Effect<boolean>;
    answer(userId: string, callId: string, answer: ElicitationAnswer): Effect.Effect<boolean>;
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

      const park = (userId: string, call: PendingIntegrationCall, timeout: Duration.Duration) =>
        Effect.gen(function* () {
          const answer = yield* Deferred.make<Answer>();
          const entry: Waiting = {
            userId,
            call: { ...call, expiresAt: Date.now() + Duration.toMillis(timeout) },
            answer,
          };
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => waiting.set(call.callId, entry)).pipe(
              Effect.andThen(announce(userId, call.conversationId)),
            ),
            () => Deferred.await(answer).pipe(Effect.timeoutOption(timeout)),
            () =>
              Effect.sync(() => {
                // Only this wait's own entry: a later one under the same row may have replaced it.
                if (waiting.get(call.callId) === entry) waiting.delete(call.callId);
              }).pipe(Effect.andThen(announce(userId, call.conversationId))),
          );
        });

      const settle = (userId: string, callId: string, answer: Answer) =>
        Effect.gen(function* () {
          const entry = waiting.get(callId);
          if (!entry || entry.userId !== userId) return false;
          if ((entry.call.kind === "elicitation") !== (answer.kind === "elicitation")) return false;
          return yield* Deferred.succeed(entry.answer, answer);
        });

      return IntegrationApprovals.of({
        request: Effect.fn("IntegrationApprovals.request")(function* (userId, call) {
          const decided = yield* park(
            userId,
            { ...call, kind: "approval", expiresAt: 0 },
            call.access === "read" ? APPROVAL_TIMEOUTS.read : APPROVAL_TIMEOUTS.change,
          );
          return decided._tag === "Some" && decided.value.kind === "decision"
            ? decided.value.value
            : "timeout";
        }),

        elicit: Effect.fn("IntegrationApprovals.elicit")(function* (userId, call) {
          const answered = yield* park(
            userId,
            { ...call, kind: "elicitation", expiresAt: 0 },
            APPROVAL_TIMEOUTS.elicitation,
          );
          return answered._tag === "Some" && answered.value.kind === "elicitation"
            ? answered.value.value
            : { action: "cancel" };
        }),

        decide: (userId, callId, answer) =>
          settle(userId, callId, { kind: "decision", value: answer }),

        answer: (userId, callId, answer) =>
          settle(userId, callId, { kind: "elicitation", value: answer }),

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
