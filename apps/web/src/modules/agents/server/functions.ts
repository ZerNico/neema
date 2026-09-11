import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import type { AgentNotAvailable, AgentRejected } from "../errors.ts";
import { AgentIdInput, AgentSettings, UpdateAgentInput } from "../schema.ts";
import { AgentService } from "./service.ts";

const publicResult = <A, R>(effect: Effect.Effect<A, AgentNotAvailable | AgentRejected, R>) =>
  effect.pipe(
    Effect.catchTag("AgentNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("AgentRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );
export const listAgents = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.flatMap(AgentService, (service) => service.list(context.session.user.id)),
    ),
  );
export const getAgent = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentService, (service) =>
          service.detail(context.session.user.id, data.agentId),
        ),
      ),
    ),
  );
export const getAgentSelection = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentService, (service) =>
          service.selection(context.session.user.id, data.agentId),
        ),
      ),
    ),
  );
export const createAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentSettings))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentService, (service) => service.create(context.session.user.id, data)),
      ),
    ),
  );
export const updateAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(UpdateAgentInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentService, (service) => service.update(context.session.user.id, data)),
      ),
    ),
  );
export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(AgentIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(AgentService, (service) =>
          service.remove(context.session.user.id, data.agentId),
        ),
      ),
    ),
  );
