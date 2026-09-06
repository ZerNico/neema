import type { Effect } from "effect";
/** Optional per-run admission and external-operation gate; ordinary chat has no policy. */
export interface WebExecutionPolicy {
  admit(kind: "search" | "read", targets: number): boolean;
  run<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Once per actual backend success/typed failure, never per cache hit or waiter. */
  observeSearch?(ok: boolean): void;
}
