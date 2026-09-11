import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  AgentDraftIdInput,
  AgentDraftRevisionInput,
  PatchAgentDraftInput,
  type AgentDraftNotAvailable,
  type AgentDraftRejected,
} from "../draft-schema.ts";
import { AgentDraftService } from "./draft-service.ts";

const publicResult = <A, R>(
  effect: Effect.Effect<A, AgentDraftNotAvailable | AgentDraftRejected, R>,
) =>
  effect.pipe(
    // Driver defects can contain SQL and the private settings being written.
    // Keep recoverable domain responses, but never serialize a driver exception.
    Effect.catchDefect(() =>
      Effect.logError("agent draft request failed").pipe(
        Effect.andThen(
          Effect.die(new Response("Could not update the agent draft", { status: 500 })),
        ),
      ),
    ),
    Effect.catchTag("AgentDraftNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("AgentDraftRejected", (error) =>
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
