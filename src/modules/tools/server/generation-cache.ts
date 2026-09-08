import { Deferred, Effect, Exit, Fiber } from "effect";

interface Pending<A, E> {
  readonly state: "pending";
  readonly result: Deferred.Deferred<A, E>;
  producer?: Fiber.Fiber<A, E>;
  waiters: number;
}
type Entry<A, E> = Pending<A, E> | { readonly state: "success"; readonly value: A };

/** Successful values and shared work belong to one generation, never the runtime. */
export const makeGenerationCache = <A, E = never>(options: {
  capacity: number;
  retain?: (value: A) => boolean;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const cache = new Map<string, Entry<A, E>>();
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        cache.clear();
      }),
    );

    return (key: string, work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closed) return yield* Effect.interrupt;
          const cached = cache.get(key);
          if (cached?.state === "success") return cached.value;
          if (!cached && cache.size >= options.capacity) {
            const oldest = [...cache].find(([, entry]) => entry.state === "success");
            if (oldest) cache.delete(oldest[0]);
            // Never evict work another waiter owns. Uncached overflow still
            // belongs to the generation and stops when its only waiter leaves.
            else {
              const producer = yield* Effect.forkIn(work, scope);
              return yield* restore(Fiber.join(producer)).pipe(
                Effect.ensuring(Fiber.interrupt(producer)),
              );
            }
          }
          const flight: Pending<A, E> = cached ?? {
            state: "pending",
            result: Deferred.makeUnsafe<A, E>(),
            waiters: 0,
          };
          // Claim and attach before forking or awaiting: two workers share one request.
          flight.waiters++;
          if (!cached) {
            cache.set(key, flight);
            flight.producer = yield* Effect.forkIn(work, scope);
            // Observers also run if scope closure kills a fiber before it starts.
            // Complete with its Exit, not work Deferred would re-run per waiter.
            flight.producer.addObserver((exit) => {
              if (cache.get(key) === flight) {
                if (Exit.isSuccess(exit) && (!options.retain || options.retain(exit.value)))
                  cache.set(key, { state: "success", value: exit.value });
                else cache.delete(key);
              }
              Deferred.doneUnsafe(flight.result, exit);
            });
          }
          return yield* restore(Deferred.await(flight.result)).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                flight.waiters--;
                if (flight.waiters === 0 && cache.get(key) === flight) {
                  // Evict before interruption so a retry cannot join dying work.
                  cache.delete(key);
                  if (flight.producer) yield* Fiber.interrupt(flight.producer);
                }
              }),
            ),
          );
        }),
      );
  });
