import { Duration, Effect, Layer, Schedule } from "effect";
import { IntegrationService } from "./service.ts";

/** How often due listings are looked for; each says itself when it is next due. */
const SWEEP_INTERVAL = Duration.minutes(10);

/**
 * Lists every catalog type's tools again when due, for each account, so what
 * chats are offered follows what the server offers now. A layer of its own,
 * so tests that hold the service have no timer.
 */
export const ToolListingSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* IntegrationService;
    yield* service.checkDueListings().pipe(
      Effect.catchCause((cause) => Effect.logError("integration tool listing sweep failed", cause)),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
