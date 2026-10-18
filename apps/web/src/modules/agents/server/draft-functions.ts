import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  AgentDraftIdInput,
  AgentDraftRevisionInput,
  PatchAgentDraftInput,
} from "../draft-schema.ts";
import { AgentDraftService } from "./draft-service.ts";

export const getAgentDraft = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentDraftService, (service) =>
        service.get(context.session.user.id, data.draftId),
      ),
    ),
  );
export const patchAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PatchAgentDraftInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentDraftService, (service) => service.patch(context.session.user.id, data)),
    ),
  );
export const saveAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftRevisionInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentDraftService, (service) => service.save(context.session.user.id, data)),
    ),
  );
export const discardAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentDraftService, (service) =>
        service.discard(context.session.user.id, data.draftId),
      ),
    ),
  );
export const reloadAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentDraftRevisionInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentDraftService, (service) => service.reload(context.session.user.id, data)),
    ),
  );
