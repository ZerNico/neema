import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireOwnSession, requireSession } from "~/modules/auth/server/middleware.ts";
import { getLocale } from "~/paraglide/runtime.js";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  PatchScheduleDraftInput,
  ScheduleDraftIdInput,
  ScheduleDraftRevisionInput,
} from "../draft-schema.ts";
import { ScheduleDraftService } from "./draft-service.ts";

export const getScheduleDraft = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.get(context.session.user.id, data.draftId),
      ),
    ),
  );
export const patchScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PatchScheduleDraftInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.patch(context.session.user.id, data),
      ),
    ),
  );
/** Saving is what creates or rewrites the schedule, so it needs the person themselves. */
export const saveScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireOwnSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) => {
    // Read here, still in the request: the effect's fibers do not carry it.
    const locale = getLocale();
    return runServerFn(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service
          .save(context.session.user.id, data)
          .pipe(
            Effect.map((result) =>
              result.outcome === "invalid" ? { ...result, reason: result.reason(locale) } : result,
            ),
          ),
      ),
    );
  });
export const discardScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.discard(context.session.user.id, data.draftId),
      ),
    ),
  );
export const reloadScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.reload(context.session.user.id, data),
      ),
    ),
  );
