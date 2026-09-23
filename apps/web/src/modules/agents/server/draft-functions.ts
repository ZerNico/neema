import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  AgentDraftIdInput,
  AgentDraftRevisionInput,
  DraftNotAvailable,
  DraftRejected,
  PatchAgentDraftInput,
} from "../draft-schema.ts";
import { AgentDraftService } from "./draft-service.ts";

// Unexpected failures (driver errors can carry SQL or the content being
// written) are logged and replaced by `reportUnexpectedFailures`.
const publicResult = <A, R>(effect: Effect.Effect<A, DraftNotAvailable | DraftRejected, R>) =>
  effect.pipe(
    Effect.catchTag("DraftNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("DraftRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );
export const getAgentDraft = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentDraftService, (service) =>
          service.get(context.session.user.id, data.draftId),
        ),
      ),
    ),
  );
export const patchAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PatchAgentDraftInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentDraftService, (service) =>
          service.patch(context.session.user.id, data),
        ),
      ),
    ),
  );
export const saveAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftRevisionInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentDraftService, (service) => service.save(context.session.user.id, data)),
      ),
    ),
  );
export const discardAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentDraftService, (service) =>
          service.discard(context.session.user.id, data.draftId),
        ),
      ),
    ),
  );
export const reloadAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftRevisionInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentDraftService, (service) =>
          service.reload(context.session.user.id, data),
        ),
      ),
    ),
  );
