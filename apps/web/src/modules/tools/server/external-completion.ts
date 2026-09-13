import { randomUUID } from "node:crypto";
import { Clock, Context, Deferred, Duration, Effect, Layer, type Scope } from "effect";

export interface ExternalWait<A> {
  readonly onTimeout: () => A;
  readonly timeout: Duration.Duration;
  readonly requireOpen?: boolean;
}

/** Execution authority is scoped to an attempt, not a page or a saved conversation. */
export interface ExternalOwner {
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly generationId: string;
  readonly executorId: string;
  /**
   * The device's own session, read from the authenticated request rather than
   * sent by it. Unlike the executor it survives a restart of the app, which is
   * what lets a fresh executor recognise its predecessor. Absent on attempts
   * started before this binding existed.
   */
  readonly deviceSessionId?: string | undefined;
}

export interface ExternalOperation extends ExternalOwner {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly expiresAt: number;
  readonly claimed: boolean;
}

interface Registration {
  readonly owner: ExternalOwner;
  readonly changed: Effect.Effect<void>;
}

/** Resolves a parked wait into its own timeout result rather than a value. */
const ABANDONED = Symbol("external-completion/abandoned");

interface Slot {
  readonly deferred: Deferred.Deferred<unknown>;
  operation?: ExternalOperation;
  token?: string;
  answered: boolean;
}

// The device session is deliberately not part of attempt identity: a claim
// carries the client's own owner fields, so requiring it would mean trusting a
// wire field, or refusing every attempt that predates it. The executor already
// tells two devices apart, which is what a claim has to enforce.
const sameOwner = (a: ExternalOwner, b: ExternalOwner) =>
  a.userId === b.userId &&
  a.conversationId === b.conversationId &&
  a.messageId === b.messageId &&
  a.generationId === b.generationId &&
  a.executorId === b.executorId;

/** What the server knows about a host checking in, every field server-derived. */
export interface ExternalCheckIn {
  readonly userId: string;
  readonly deviceSessionId: string;
  readonly executorId: string;
}

/**
 * Same device, earlier app lifetime. That executor is gone for good, so nothing
 * can ever claim the attempt's calls and only the deadline would end them.
 * Another device's attempt is left alone, so a second device still cannot take
 * work from the first, and an attempt with no device session keeps its deadline.
 */
export const supersededByCheckIn = (owner: ExternalOwner, checkIn: ExternalCheckIn) =>
  owner.userId === checkIn.userId &&
  owner.deviceSessionId !== undefined &&
  owner.deviceSessionId === checkIn.deviceSessionId &&
  owner.executorId !== checkIn.executorId;

/**
 * Bounded, scoped waits for externally executed tools. The optional owner and
 * claim bind side effects to the initiating executor. Completed results stay
 * available for a handler that starts waiting after a fast reply arrives.
 */
export class ExternalCompletion extends Context.Service<
  ExternalCompletion,
  {
    track(
      owner: ExternalOwner,
      changed: Effect.Effect<void>,
    ): Effect.Effect<void, never, Scope.Scope>;
    open(
      callId: string,
      operation?: Omit<ExternalOperation, "callId" | "expiresAt" | "claimed"> & {
        timeoutMs: number;
      },
    ): Effect.Effect<void, never, Scope.Scope>;
    await<A>(callId: string, wait: ExternalWait<A>): Effect.Effect<A>;
    complete(callId: string, value: unknown): Effect.Effect<boolean>;
    pending(callId: string): Effect.Effect<boolean>;
    inspect(callId: string): Effect.Effect<ExternalOperation | null>;
    owners(): Effect.Effect<ExternalOwner[]>;
    snapshot(
      userId: string,
      executorId: string,
    ): Effect.Effect<{
      attempts: ExternalOwner[];
      calls: ExternalOperation[];
    }>;
    claim(callId: string, owner: ExternalOwner): Effect.Effect<string | null>;
    completeClaim(
      callId: string,
      owner: ExternalOwner,
      token: string,
      value: unknown,
    ): Effect.Effect<boolean>;
    cancelAttempt(owner: ExternalOwner): Effect.Effect<void>;
    /** See `supersededByCheckIn`: ends this device's abandoned attempts. */
    cancelSuperseded(checkIn: ExternalCheckIn): Effect.Effect<void>;
  }
>()("chat/tools/ExternalCompletion") {
  static readonly layer = Layer.effect(
    ExternalCompletion,
    Effect.sync(() => {
      const waiting = new Map<string, Slot>();
      const attempts = new Map<string, Registration>();
      const changed = (owner?: ExternalOwner) =>
        owner ? (attempts.get(owner.generationId)?.changed ?? Effect.void) : Effect.void;
      const close = (callId: string, slot: Slot) =>
        Effect.suspend(() => {
          if (waiting.get(callId) !== slot) return Effect.void;
          waiting.delete(callId);
          return changed(slot.operation);
        });
      const slotFor = Effect.fnUntraced(function* (callId: string) {
        const existing = waiting.get(callId);
        if (existing) return existing;
        const slot: Slot = { deferred: yield* Deferred.make<unknown>(), answered: false };
        waiting.set(callId, slot);
        return slot;
      });
      const inspect = (callId: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const slot = waiting.get(callId);
          const op = slot?.operation;
          return slot && !slot.answered && op && op.expiresAt > now && attempts.has(op.generationId)
            ? op
            : null;
        });
      const complete = (callId: string, value: unknown) =>
        Effect.gen(function* () {
          const slot = waiting.get(callId);
          if (!slot || slot.answered) return false;
          slot.answered = true;
          const accepted = yield* Deferred.succeed(slot.deferred, value);
          yield* changed(slot.operation);
          return accepted;
        });
      /**
       * Ends an attempt. Interrupting takes the generation with it, which is
       * right when the generation is already over. Abandoning instead wakes
       * each parked wait as its own deadline would, so the handler returns its
       * failure and the model can still answer.
       */
      const endAttempt = (owner: ExternalOwner, abandon: boolean) =>
        Effect.gen(function* () {
          const current = attempts.get(owner.generationId);
          if (!current || !sameOwner(current.owner, owner)) return;
          attempts.delete(owner.generationId);
          for (const slot of waiting.values()) {
            if (slot.operation && sameOwner(slot.operation, owner)) {
              slot.answered = true;
              yield* abandon
                ? Deferred.succeed(slot.deferred, ABANDONED)
                : Deferred.interrupt(slot.deferred);
            }
          }
          yield* current.changed;
        });
      const cancelAttempt = (owner: ExternalOwner) => endAttempt(owner, false);
      return ExternalCompletion.of({
        track: (owner, notify) =>
          Effect.gen(function* () {
            attempts.set(owner.generationId, { owner, changed: notify });
            yield* Effect.addFinalizer(() => cancelAttempt(owner));
            yield* notify;
          }),
        open: (callId, operation) =>
          Effect.gen(function* () {
            const slot = yield* slotFor(callId);
            if (operation && !slot.operation) {
              const { timeoutMs, ...fields } = operation;
              slot.operation = {
                ...fields,
                callId,
                claimed: false,
                expiresAt: (yield* Clock.currentTimeMillis) + timeoutMs,
              };
            }
            yield* Effect.addFinalizer(() => close(callId, slot));
            yield* changed(slot.operation);
          }),
        await: <A>(callId: string, wait: ExternalWait<A>) =>
          Effect.gen(function* () {
            if (wait.requireOpen && !waiting.has(callId)) return wait.onTimeout();
            const slot = yield* slotFor(callId);
            // The attempt behind this call is gone, so no host can ever claim
            // it. Report what the deadline would report, without the wait.
            if (slot.operation && !attempts.has(slot.operation.generationId))
              return wait.onTimeout();
            yield* Effect.addFinalizer(() => close(callId, slot));
            const timeout = slot.operation
              ? Duration.millis(
                  Math.max(
                    0,
                    Math.min(
                      Duration.toMillis(wait.timeout),
                      slot.operation.expiresAt - (yield* Clock.currentTimeMillis),
                    ),
                  ),
                )
              : wait.timeout;
            const answered = yield* Deferred.await(slot.deferred).pipe(
              Effect.timeoutOption(timeout),
            );
            return answered._tag === "Some" && answered.value !== ABANDONED
              ? (answered.value as A)
              : wait.onTimeout();
          }).pipe(Effect.scoped),
        complete,
        pending: (callId) => Effect.sync(() => waiting.has(callId)),
        inspect,
        owners: () => Effect.sync(() => [...attempts.values()].map(({ owner }) => owner)),
        snapshot: (userId, executorId) =>
          Effect.gen(function* () {
            const owned = [...attempts.values()].filter(
              ({ owner }) => owner.userId === userId && owner.executorId === executorId,
            );
            const calls: ExternalOperation[] = [];
            for (const id of waiting.keys()) {
              const op = yield* inspect(id);
              if (op?.userId === userId && op.executorId === executorId) calls.push(op);
            }
            return { attempts: owned.map(({ owner }) => owner), calls };
          }),
        claim: (callId, owner) =>
          Effect.gen(function* () {
            const op = yield* inspect(callId);
            if (!op || !sameOwner(op, owner)) return null;
            const slot = waiting.get(callId);
            if (
              !slot ||
              slot.operation !== op ||
              slot.answered ||
              !attempts.has(owner.generationId)
            )
              return null;
            slot.token ??= randomUUID();
            slot.operation = { ...op, claimed: true };
            return slot.token;
          }),
        completeClaim: (callId, owner, token, value) =>
          Effect.gen(function* () {
            const op = yield* inspect(callId);
            if (!op || !sameOwner(op, owner) || waiting.get(callId)?.token !== token) return false;
            return yield* complete(callId, value);
          }),
        cancelAttempt,
        // Read the registry into an array first: cancelling removes entries.
        cancelSuperseded: (checkIn) =>
          Effect.forEach(
            [...attempts.values()]
              .map(({ owner }) => owner)
              .filter((owner) => supersededByCheckIn(owner, checkIn)),
            // Abandon rather than interrupt: the generation is still alive and
            // can say the app closed, instead of dying at its lease.
            (owner) => endAttempt(owner, true),
            { discard: true },
          ),
      });
    }),
  );
}
