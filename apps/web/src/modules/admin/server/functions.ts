import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin } from "~/modules/auth/server/middleware.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import {
  effectiveSettings,
  getPreset,
  resolveBaseUrl,
  type AuthKind,
  type Preset,
} from "@chat/model-client";
import { encodeAwsKeys, type AwsKeys } from "~/modules/providers/aws-keys.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { runtime } from "~/server/runtime.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import {
  CreateGroupInput,
  UpdateDefaultCapabilitiesInput,
  UpdateGroupCapabilitiesInput,
  CreateModelInput,
  CreateProviderInput,
  GroupIdInput,
  GroupMemberInput,
  ModelIdInput,
  ProbeModelInput,
  ProviderIdInput,
  RenameGroupInput,
  UpdateDefaultModelOrderInput,
  UpdateGroupMemberSharingInput,
  UpdateModelInput,
  UpdateProviderInput,
  UpdateUtilityModelInput,
} from "../schema.ts";

const standard = Schema.toStandardSchemaV1;

export const listProviders = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(ProviderRepo.use((repo) => repo.listProviders())));

const needsBaseUrl = (preset: Preset) =>
  new Response(
    preset.baseUrlLabel
      ? `${preset.label} needs a ${preset.baseUrlLabel.toLowerCase()}.`
      : `${preset.label} needs the base URL of your server.`,
    { status: 400 },
  );

const refused = (reason: string) => new Response(reason, { status: 400 });

/**
 * The one secret a provider stores, of the kind it signs in with: a key, or
 * AWS access keys as one document. The other kind is refused, never stored.
 */
const storedSecret = (
  preset: Preset,
  auth: AuthKind,
  input: { readonly apiKey?: string; readonly awsKeys?: AwsKeys },
) => {
  if (auth === "aws") {
    if (input.apiKey?.trim()) throw refused(`${preset.label} is set to sign with an access key.`);
    return input.awsKeys ? encodeAwsKeys(input.awsKeys) : undefined;
  }
  if (input.awsKeys) throw refused(`${preset.label} is set to use an API key.`);
  return input.apiKey?.trim() || undefined;
};

const missingSecret = (preset: Preset, auth: AuthKind) =>
  refused(`${preset.label} needs ${auth === "aws" ? "an access key" : "an API key"}.`);

export const createProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateProviderInput))
  .handler(({ data }) => {
    const { awsKeys: _awsKeys, apiKey: _apiKey, ...rest } = data;
    const preset = getPreset(data.preset);
    if (!resolveBaseUrl(preset, data.baseUrl)) throw needsBaseUrl(preset);
    const auth = effectiveSettings(preset, data.settings).auth;
    const secret = storedSecret(preset, auth, data);
    if (!secret && (preset.keyRequired || auth === "aws")) throw missingSecret(preset, auth);
    return runtime.runPromise(
      ProviderRepo.use((repo) =>
        repo.createProvider({ ...rest, ...(secret ? { apiKey: secret } : {}) }),
      ),
    );
  });

export const updateProvider = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateProviderInput))
  .handler(({ data }) => {
    const { providerId, ...patch } = data;
    return runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ProviderRepo;
        const provider = (yield* repo.listProviders()).find((row) => row.id === providerId);
        if (!provider) return;
        const preset = getPreset(provider.preset);
        if (patch.baseUrl !== undefined && !resolveBaseUrl(preset, patch.baseUrl))
          return yield* Effect.die(needsBaseUrl(preset));
        const { awsKeys: _awsKeys, apiKey: _apiKey, ...rest } = patch;
        const current = effectiveSettings(preset, provider.settings).auth;
        const auth = patch.settings ? effectiveSettings(preset, patch.settings).auth : current;
        const secret = yield* Effect.try({
          try: () => storedSecret(preset, auth, patch),
          catch: (response) => response,
        }).pipe(Effect.orDie);
        // The stored secret is of the old kind, so a switch needs new credentials.
        if (auth !== current && !secret && (preset.keyRequired || auth === "aws"))
          return yield* Effect.die(missingSecret(preset, auth));
        yield* repo.updateProvider(providerId, { ...rest, ...(secret ? { apiKey: secret } : {}) });
      }),
    );
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
        yield* repo.setDefaultModelOrder(data.modelIds, data.type ?? "chat");
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

export const getUtilityModel = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runtime.runPromise(
      ProviderRepo.use((repo) => repo.getUtilityModelId()).pipe(
        Effect.map((modelId) => ({ modelId })),
      ),
    ),
  );

export const updateUtilityModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateUtilityModelInput))
  .handler(({ data }) =>
    runtime.runPromise(
      ProviderRepo.use((repo) => repo.setUtilityModelId(data.modelId)).pipe(
        Effect.catchTag("InvalidUtilityModel", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

export const createModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateModelInput))
  .handler(({ data }) =>
    runtime.runPromise(
      ProviderRepo.use((repo) => repo.createModel(data)).pipe(
        Effect.catchTag("UnhostedImageFamily", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

export const updateModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateModelInput))
  .handler(({ data }) => {
    const { modelId, ...patch } = data;
    return runtime.runPromise(
      ProviderRepo.use((repo) => repo.updateModel(modelId, patch)).pipe(
        Effect.catchTag("UnhostedImageFamily", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    );
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
          repo.setMemberSharing(data.groupId, data.userId, data.sharing),
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

export const getGroupCapabilities = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runtime.runPromise(
      GroupRepo.use((repo) => repo.getGroupCapabilities(data.groupId)).pipe(
        Effect.catchTag("GroupNotFound", groupGone),
      ),
    ),
  );

export const updateGroupCapabilities = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateGroupCapabilitiesInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(
        GroupRepo.use((repo) => repo.updateGroupCapabilities(data.groupId, data.capabilities)),
      ).pipe(Effect.catchTag("GroupNotFound", groupGone)),
    ),
  );

export const getDefaultCapabilities = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(GroupRepo.use((repo) => repo.getDefaultCapabilities())));

export const updateDefaultCapabilities = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDefaultCapabilitiesInput))
  .handler(({ data }) =>
    runtime.runPromise(
      groupChanged(GroupRepo.use((repo) => repo.updateDefaultCapabilities(data.capabilities))),
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
  .validator(standard(ProbeModelInput))
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

/**
 * One short request to a chat model before it is saved, so a wrong model ID
 * or key shows up in the dialog instead of in someone's first chat.
 */
export const testChatModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ProbeModelInput))
  .handler(({ data }) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const started = Date.now();
        const { reply, format } = yield* (yield* AiGateway).probeChatModel(data);
        return {
          ok: true as const,
          reply,
          latencyMs: Date.now() - started,
          ...(format ? { format } : {}),
        };
      }).pipe(
        Effect.catchTags({
          ProviderUnreachable: (error) =>
            Effect.succeed({ ok: false as const, error: error.message }),
          ProviderContextOverflow: (error) =>
            Effect.succeed({ ok: false as const, error: error.message }),
          ModelNotFound: () => Effect.succeed({ ok: false as const, error: "Provider not found." }),
        }),
      ),
    ),
  );
