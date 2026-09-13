import { Effect, Queue, Stream } from "effect";

// Subscribe before reading state; keep one dirty bit while that read runs.
// The scope owns the relay, so cancelled runs cannot leave listeners behind.
export const wakeOn = <A>(signals: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(signals);
    const pending = yield* Queue.sliding<void>(1);
    yield* Stream.fromEffectRepeat(pull).pipe(
      Stream.runForEach(() => Queue.offer(pending, undefined)),
      Effect.forkScoped,
    );
    // SyncBus emits readiness only after subscribing; toPull alone is lazy.
    yield* Queue.take(pending);
    yield* Queue.offer(pending, undefined);
    return Queue.take(pending);
  });
