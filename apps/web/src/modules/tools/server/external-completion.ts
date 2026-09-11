import { Context, Deferred, Duration, Effect, Layer, type Scope } from "effect";

/**
 * Lets one tool handler block until something outside this process answers it.
 *
 * This is the only place a chat generation is allowed to wait on the world.
 * Everything about that wait is dangerous in a specific way, so it is all here
 * rather than repeated per tool:
 *
 * - **It must be bounded.** The chunk flusher renews `generation_lease_until`
 *   every 250 ms whether or not anything is happening, by design, so a slow
 *   first token is never reaped. A handler blocked forever therefore renews
 *   forever and the row becomes unreapable. The timeout is what ends it, and it
 *   resolves as a value the model can read rather than an exception.
 * - **A late answer must land nowhere.** Registration is scoped: when the
 *   waiting handler ends for any reason, Stop and timeout included, the entry
 *   goes with it. `complete` on an id nobody is waiting for is a no-op.
 * - **It is in-process**, exactly like the in-flight generation map and the live
 *   chunk tail. One Node process is the deployment; a restart mid-wait strands
 *   the call until its timeout, which is why the timeout is not optional.
 *
 * Kept free of any knowledge of the desktop so deep research can sit behind the
 * same primitive when its runner moves into a tool handler.
 */

export interface ExternalWait<A> {
  /** What the model is told when nobody answers in time. */
  readonly onTimeout: () => A;
  readonly timeout: Duration.Duration;
}

export class ExternalCompletion extends Context.Service<
  ExternalCompletion,
  {
    /**
     * Opens a slot before the call is announced.
     *
     * Announcing and waiting are separate moments: the loop tells the page
     * about a call as soon as it writes the row, and the handler only starts
     * waiting a step later. Without a slot open across that gap, an answer
     * from a fast machine would arrive with nobody registered and be dropped,
     * which reads as a hang rather than as the race it is. The slot is closed
     * with the caller's scope.
     */
    open(callId: string): Effect.Effect<void, never, Scope.Scope>;
    /**
     * Waits for `complete` and gives up after the timeout. Takes over whatever
     * slot `open` left, answer included, and closes it however the wait ends.
     */
    await<A>(callId: string, wait: ExternalWait<A>): Effect.Effect<A>;
    /** Answers a waiting call. Unknown ids are dropped, never an error. */
    complete(callId: string, value: unknown): Effect.Effect<boolean>;
    /** Whether a slot for this id is currently open. */
    pending(callId: string): Effect.Effect<boolean>;
  }
>()("chat/tools/ExternalCompletion") {
  static readonly layer = Layer.effect(
    ExternalCompletion,
    Effect.sync(() => {
      const waiting = new Map<string, Deferred.Deferred<unknown>>();
      const slotFor = Effect.fnUntraced(function* (callId: string) {
        const existing = waiting.get(callId);
        if (existing) return existing;
        const slot = yield* Deferred.make<unknown>();
        waiting.set(callId, slot);
        return slot;
      });

      return ExternalCompletion.of({
        open: (callId) =>
          Effect.gen(function* () {
            yield* slotFor(callId);
            yield* Effect.addFinalizer(() => Effect.sync(() => void waiting.delete(callId)));
          }),

        await: <A>(callId: string, wait: ExternalWait<A>) =>
          Effect.gen(function* () {
            const slot = yield* slotFor(callId);
            // Removed however the wait ends, even when `open` holds a longer
            // scope. A result arriving after Stop or a timeout then finds no
            // entry, which keeps it off a row already marked terminal.
            yield* Effect.addFinalizer(() => Effect.sync(() => void waiting.delete(callId)));
            const answered = yield* Deferred.await(slot).pipe(Effect.timeoutOption(wait.timeout));
            return answered._tag === "Some" ? (answered.value as A) : wait.onTimeout();
          }).pipe(Effect.scoped),

        complete: (callId, value) =>
          Effect.suspend(() => {
            const slot = waiting.get(callId);
            if (!slot) return Effect.succeed(false);
            return Effect.as(Deferred.succeed(slot, value), true);
          }),

        pending: (callId) => Effect.sync(() => waiting.has(callId)),
      });
    }),
  );
}
