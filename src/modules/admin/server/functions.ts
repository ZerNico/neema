import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin } from "~/modules/auth/server/middleware.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import {
  CreateModelInput,
  CreateProviderInput,
  ModelIdInput,
  ProviderIdInput,
  UpdateModelInput,
  UpdateProviderInput,
} from "../schema.ts";

const standard = Schema.toStandardSchemaV1;

export const listProviders = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ProviderRepo.use((repo) => repo.listProviders())));

export const createProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateProviderInput))
  .handler(({ data }) => runtime.runPromise(ProviderRepo.use((repo) => repo.createProvider(data))));

export const updateProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateProviderInput))
  .handler(({ data }) => {
    const { providerId, ...patch } = data;
    return runtime.runPromise(ProviderRepo.use((repo) => repo.updateProvider(providerId, patch)));
  });

export const deleteProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ProviderIdInput))
  .handler(({ data }) =>
    runtime.runPromise(ProviderRepo.use((repo) => repo.deleteProvider(data.providerId))),
  );

// Live model catalog from the provider's /models endpoint (autocomplete source).
export const fetchProviderCatalog = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(ProviderIdInput))
  .handler(({ data }) =>
    runtime.runPromise(
      AiGateway.use((gateway) => gateway.fetchCatalog(data.providerId)).pipe(
        Effect.map((models) => ({ ok: true as const, models })),
        Effect.catchTags({
          ProviderUnreachable: (e) => Effect.succeed({ ok: false as const, error: e.message }),
          ModelNotFound: () => Effect.succeed({ ok: false as const, error: "Provider not found" }),
        }),
      ),
    ),
  );

export const listModels = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ProviderRepo.use((repo) => repo.listModels())));

export const createModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateModelInput))
  .handler(({ data }) => runtime.runPromise(ProviderRepo.use((repo) => repo.createModel(data))));

export const updateModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateModelInput))
  .handler(({ data }) => {
    const { modelId, ...patch } = data;
    return runtime.runPromise(ProviderRepo.use((repo) => repo.updateModel(modelId, patch)));
  });

export const deleteModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ModelIdInput))
  .handler(({ data }) =>
    runtime.runPromise(ProviderRepo.use((repo) => repo.deleteModel(data.modelId))),
  );
