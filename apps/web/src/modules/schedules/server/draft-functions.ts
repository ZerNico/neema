import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  DraftNotAvailable,
  DraftRejected,
} from "~/modules/drafts/draft-schema.ts";
import {
  PatchScheduleDraftInput,
  ScheduleDraftIdInput,
  ScheduleDraftRevisionInput,
} from "../draft-schema.ts";
import { ScheduleDraftService } from "./draft-service.ts";

const publicResult = <A, R>(
  effect: Effect.Effect<A, DraftNotAvailable | DraftRejected, R>,
) =>
  effect.pipe(
    // Driver defects can contain SQL and the private settings being written.
    // Keep recoverable domain responses, but never serialize a driver exception.
    Effect.catchDefect(() =>
      Effect.logError("schedule draft request failed").pipe(
        Effect.andThen(
          Effect.die(new Response("Could not update the schedule draft", { status: 500 })),
        ),
      ),
    ),
    Effect.catchTag("DraftNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("DraftRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );
export const getScheduleDraft = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleDraftService, (service) =>
          service.get(context.session.user.id, data.draftId),
        ),
      ),
    ),
  );
export const patchScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PatchScheduleDraftInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleDraftService, (service) =>
          service.patch(context.session.user.id, data),
        ),
      ),
    ),
  );
export const saveScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleDraftService, (service) =>
          service.save(context.session.user.id, data),
        ),
      ),
    ),
  );
export const discardScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleDraftService, (service) =>
          service.discard(context.session.user.id, data.draftId),
        ),
      ),
    ),
  );
export const reloadScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleDraftService, (service) =>
          service.reload(context.session.user.id, data),
        ),
      ),
    ),
  );
