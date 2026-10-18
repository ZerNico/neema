import { Effect, type ManagedRuntime } from "effect";
import { runtime } from "~/server/runtime.ts";
import type { DraftNotAvailable, DraftRejected } from "../draft-schema.ts";

/**
 * Runs one draft server function, answering the expected draft failures with
 * HTTP statuses. Unexpected failures (driver errors can carry SQL or the
 * content being written) are logged and replaced by `reportUnexpectedFailures`.
 */
export const runDraftCall = <A>(
  effect: Effect.Effect<
    A,
    DraftNotAvailable | DraftRejected,
    ManagedRuntime.ManagedRuntime.Services<typeof runtime>
  >,
) =>
  runtime.runPromise(
    effect.pipe(
      Effect.catchTag("DraftNotAvailable", () =>
        Effect.die(new Response("Not found", { status: 404 })),
      ),
      Effect.catchTag("DraftRejected", (error) =>
        Effect.die(new Response(error.reason, { status: 400 })),
      ),
    ),
  );
