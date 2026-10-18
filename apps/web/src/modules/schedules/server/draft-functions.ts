import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runDraftCall } from "~/modules/drafts/server/functions.ts";
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
    runDraftCall(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.get(context.session.user.id, data.draftId),
      ),
    ),
  );
export const patchScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PatchScheduleDraftInput))
  .handler(({ context, data }) =>
    runDraftCall(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.patch(context.session.user.id, data),
      ),
    ),
  );
export const saveScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) =>
    runDraftCall(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.save(context.session.user.id, data),
      ),
    ),
  );
export const discardScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftIdInput))
  .handler(({ context, data }) =>
    runDraftCall(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.discard(context.session.user.id, data.draftId),
      ),
    ),
  );
export const reloadScheduleDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleDraftRevisionInput))
  .handler(({ context, data }) =>
    runDraftCall(
      Effect.flatMap(ScheduleDraftService, (service) =>
        service.reload(context.session.user.id, data),
      ),
    ),
  );
