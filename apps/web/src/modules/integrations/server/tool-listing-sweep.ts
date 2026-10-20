import { Duration, Effect, Layer, Schedule } from "effect";
import { IntegrationService } from "./service.ts";

/** How often due catalogs are looked for; each says itself when it is next due. */
const SWEEP_INTERVAL = Duration.minutes(10);

/**
 * Lists every catalog type's tools again when due, so a tool a server
 * changed waits for review instead of reaching chats under its old approval.
 * A layer of its own, so tests that hold the service have no timer.
 */
export const IntegrationCatalogSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* IntegrationService;
    yield* service.checkDueCatalogs().pipe(
      Effect.catchCause((cause) => Effect.logError("integration catalog sweep failed", cause)),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
