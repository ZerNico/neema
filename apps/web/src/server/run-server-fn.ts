import type { Effect, ManagedRuntime } from "effect";
import { type Refusable, type RefusalOverrides, refusing, type TypedErrors } from "./refusal.ts";
import { runtime } from "./runtime.ts";

/**
 * Runs a server function's effect on the app runtime, answering each expected
 * failure with its refusal (`refusal.ts`). An error the table does not know
 * fails to compile here rather than reaching the client as a 500.
 */
export const runServerFn = <A, E extends Refusable>(
  effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>> &
    TypedErrors<E>,
  overrides?: RefusalOverrides,
) => runtime.runPromise(refusing(effect, overrides));
