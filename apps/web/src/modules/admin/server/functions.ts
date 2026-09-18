import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin } from "~/modules/auth/server/middleware.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import {
  CreateGroupInput,
  CreateModelInput,
  CreateProviderInput,
  GroupIdInput,
  GroupMemberInput,
  ModelIdInput,
  ProbeEmbeddingDimensionsInput,
  ProviderIdInput,
  RenameGroupInput,
  UpdateDefaultModelOrderInput,
  UpdateGroupMemberSharingInput,
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

/**
 * Live model catalog from the provider's /models endpoint (autocomplete source).
 */
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

export const updateDefaultModelOrder = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDefaultModelOrderInput))
  .handler(({ data }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProviderRepo;
        const sync = yield* SyncBus;
        yield* repo.setDefaultModelOrder(data.modelIds);
        yield* sync
          .publishGlobal({ type: "models.defaults.changed" })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("model defaults changed but sync publication failed"),
            ),
          );
      }).pipe(
        Effect.catchTag("InvalidDefaultModelOrder", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

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

// --- Groups ---

const groupChanged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tap(() =>
      Effect.flatMap(SyncBus, (bus) => bus.publishGlobal({ type: "resources.changed" })).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("group changed but resource invalidation failed"),
        ),
      ),
    ),
  );

export const updateGroupMemberSharing = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateGroupMemberSharingInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(
        Effect.flatMap(GroupRepo, (repo) =>
          repo.setMemberSharing(data.groupId, data.userId, data.canShare),
        ),
      ).pipe(
        Effect.catchTag("GroupMemberNotFound", () =>
          Effect.die(new Response("Group member not found", { status: 404 })),
        ),
      ),
    ),
  );

const conflict = () => Effect.die(new Response("Group name already taken", { status: 409 }));
const groupGone = () => Effect.die(new Response("Group not found", { status: 404 }));

export const listGroups = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(GroupRepo.use((repo) => repo.listGroups())));

export const createGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateGroupInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(GroupRepo.use((repo) => repo.createGroup(data.name))).pipe(
        Effect.catchTag("GroupNameTaken", conflict),
      ),
    ),
  );

export const renameGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(RenameGroupInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(GroupRepo.use((repo) => repo.renameGroup(data.groupId, data.name))).pipe(
        Effect.catchTag("GroupNameTaken", conflict),
        Effect.catchTag("GroupNotFound", groupGone),
      ),
    ),
  );

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runtime.runPromise(groupChanged(GroupRepo.use((repo) => repo.deleteGroup(data.groupId)))),
  );

export const getGroup = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runtime.runPromise(
      GroupRepo.use((repo) => repo.getGroup(data.groupId)).pipe(
        Effect.catchTag("GroupNotFound", groupGone),
      ),
    ),
  );

export const listGroupMembers = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runtime.runPromise(GroupRepo.use((repo) => repo.listMembers(data.groupId))),
  );

export const listGroupMemberships = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(GroupRepo.use((repo) => repo.listMemberships())));

export const addGroupMember = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupMemberInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(GroupRepo.use((repo) => repo.addMember(data.groupId, data.userId))),
    ),
  );

export const removeGroupMember = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupMemberInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(GroupRepo.use((repo) => repo.removeMember(data.groupId, data.userId))),
    ),
  );

/**
 * --- Model access ---
 */

export const listModelAccess = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ProviderRepo.use((repo) => repo.listModelAccess())));

/**
 * One probe request to learn an embedding model's vector width before the
 * model is saved. Catalogs do not carry it. Failures come back as a message,
 * not an exception: the admin can still type the number by hand.
 */
export const probeEmbeddingDimensions = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ProbeEmbeddingDimensionsInput))
  .handler(({ data }) =>
    runtime.runPromise(
      AiGateway.use((gateway) => gateway.probeEmbeddingDimensions(data)).pipe(
        Effect.map((result) => ({ ok: true as const, dimensions: result.dimensions })),
        Effect.catchTags({
          ProviderUnreachable: (error) =>
            Effect.succeed({ ok: false as const, error: error.message }),
          ModelNotFound: () => Effect.succeed({ ok: false as const, error: "Provider not found." }),
        }),
      ),
    ),
  );
