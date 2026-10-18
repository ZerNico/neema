import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { AgentIdInput, AgentSettings, UpdateAgentInput } from "../schema.ts";
import { AgentService } from "./service.ts";

export const listAgents = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(Effect.flatMap(AgentService, (service) => service.list(context.session.user.id))),
  );
export const getAgent = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentService, (service) =>
        service.detail(context.session.user.id, data.agentId),
      ),
    ),
  );
export const getAgentSelection = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentService, (service) =>
        service.selection(context.session.user.id, data.agentId),
      ),
    ),
  );
export const createAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentSettings))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentService, (service) => service.create(context.session.user.id, data)),
    ),
  );
export const updateAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(UpdateAgentInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentService, (service) => service.update(context.session.user.id, data)),
    ),
  );
export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(AgentService, (service) =>
        service.remove(context.session.user.id, data.agentId),
      ),
    ),
  );
