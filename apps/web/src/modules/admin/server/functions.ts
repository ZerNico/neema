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
import { type Localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";
import { refusal } from "~/server/refusal.ts";
import { presetLabel } from "../preset-words.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
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
  .handler(() => runServerFn(ProviderRepo.use((repo) => repo.listProviders())));

/** A refusal naming the preset, in whichever locale reads it. */
const refused = (
  preset: Preset,
  message: (inputs: { provider: string }, options: { locale: Locale }) => string,
) => {
  const reason: Localized = (locale) =>
    message({ provider: presetLabel(preset, locale) }, { locale });
  return refusal(400, reason);
};

/** A probe's answer when its provider is gone, worded while the request's locale is known. */
const providerNotFound = (locale: Locale) => ({
  ok: false as const,
  error: m.admin_error_provider_not_found({}, { locale }),
});

// The only labelled base URL is Bedrock's region.
const needsBaseUrl = (preset: Preset) =>
  refused(preset, preset.baseUrlLabel ? m.admin_error_needs_region : m.admin_error_needs_base_url);

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
    if (input.apiKey?.trim()) throw refused(preset, m.admin_error_uses_access_key);
    return input.awsKeys ? encodeAwsKeys(input.awsKeys) : undefined;
  }
  if (input.awsKeys) throw refused(preset, m.admin_error_uses_api_key);
  return input.apiKey?.trim() || undefined;
};

const missingSecret = (preset: Preset, auth: AuthKind) =>
  refused(preset, auth === "aws" ? m.admin_error_needs_access_key : m.admin_error_needs_api_key);

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
    return runServerFn(
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
    return runServerFn(
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
    runServerFn(ProviderRepo.use((repo) => repo.deleteProvider(data.providerId))),
  );

/**
 * Live model catalog from the provider's /models endpoint (autocomplete source).
 */
export const fetchProviderCatalog = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(ProviderIdInput))
  .handler(({ data }) => {
    const locale = getLocale();
    return runServerFn(
      AiGateway.use((gateway) => gateway.fetchCatalog(data.providerId)).pipe(
        Effect.map((models) => ({ ok: true as const, models })),
        Effect.catchTags({
          ProviderUnreachable: (e) => Effect.succeed({ ok: false as const, error: e.message }),
          ModelNotFound: () => Effect.succeed(providerNotFound(locale)),
        }),
      ),
    );
  });

export const listModels = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ProviderRepo.use((repo) => repo.listModels())));

export const updateDefaultModelOrder = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDefaultModelOrderInput))
  .handler(({ data }) =>
    runServerFn(
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
      }),
    ),
  );

export const getUtilityModel = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      ProviderRepo.use((repo) => repo.getUtilityModelId()).pipe(
        Effect.map((modelId) => ({ modelId })),
      ),
    ),
  );

export const updateUtilityModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateUtilityModelInput))
  .handler(({ data }) =>
    runServerFn(ProviderRepo.use((repo) => repo.setUtilityModelId(data.modelId))),
  );

export const createModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateModelInput))
  .handler(({ data }) => runServerFn(ProviderRepo.use((repo) => repo.createModel(data))));

export const updateModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateModelInput))
  .handler(({ data }) => {
    const { modelId, ...patch } = data;
    return runServerFn(ProviderRepo.use((repo) => repo.updateModel(modelId, patch)));
  });

export const deleteModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ModelIdInput))
  .handler(({ data }) => runServerFn(ProviderRepo.use((repo) => repo.deleteModel(data.modelId))));

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
    runServerFn(
      groupChanged(
        Effect.flatMap(GroupRepo, (repo) =>
          repo.setMemberSharing(data.groupId, data.userId, data.sharing),
        ),
      ),
    ),
  );

export const listGroups = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(GroupRepo.use((repo) => repo.listGroups())));

export const createGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateGroupInput))
  .handler(({ data }) =>
    runServerFn(groupChanged(GroupRepo.use((repo) => repo.createGroup(data.name)))),
  );

export const renameGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(RenameGroupInput))
  .handler(({ data }) =>
    runServerFn(groupChanged(GroupRepo.use((repo) => repo.renameGroup(data.groupId, data.name)))),
  );

export const deleteGroup = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runServerFn(groupChanged(GroupRepo.use((repo) => repo.deleteGroup(data.groupId)))),
  );

export const getGroupCapabilities = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) =>
    runServerFn(GroupRepo.use((repo) => repo.getGroupCapabilities(data.groupId))),
  );

export const updateGroupCapabilities = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateGroupCapabilitiesInput))
  .handler(({ data }) =>
    runServerFn(
      groupChanged(
        GroupRepo.use((repo) => repo.updateGroupCapabilities(data.groupId, data.capabilities)),
      ),
    ),
  );

export const getDefaultCapabilities = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(GroupRepo.use((repo) => repo.getDefaultCapabilities())));

export const updateDefaultCapabilities = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(UpdateDefaultCapabilitiesInput))
  .handler(({ data }) =>
    runServerFn(
      groupChanged(GroupRepo.use((repo) => repo.updateDefaultCapabilities(data.capabilities))),
    ),
  );

export const listGroupMembers = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(GroupIdInput))
  .handler(({ data }) => runServerFn(GroupRepo.use((repo) => repo.listMembers(data.groupId))));

export const listGroupMemberships = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(GroupRepo.use((repo) => repo.listMemberships())));

export const addGroupMember = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupMemberInput))
  .handler(({ data }) =>
    runServerFn(groupChanged(GroupRepo.use((repo) => repo.addMember(data.groupId, data.userId)))),
  );

export const removeGroupMember = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupMemberInput))
  .handler(({ data }) =>
    runServerFn(
      groupChanged(GroupRepo.use((repo) => repo.removeMember(data.groupId, data.userId))),
    ),
  );

/**
 * --- Model access ---
 */

export const listModelAccess = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(ProviderRepo.use((repo) => repo.listModelAccess())));

/**
 * One probe request to learn an embedding model's vector width before the
 * model is saved. Catalogs do not carry it. Failures come back as a message,
 * not an exception: the admin can still type the number by hand.
 */
export const probeEmbeddingDimensions = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ProbeModelInput))
  .handler(({ data }) => {
    const locale = getLocale();
    return runServerFn(
      AiGateway.use((gateway) => gateway.probeEmbeddingDimensions(data)).pipe(
        Effect.map((result) => ({ ok: true as const, dimensions: result.dimensions })),
        Effect.catchTags({
          ProviderUnreachable: (error) =>
            Effect.succeed({ ok: false as const, error: error.message }),
          ModelNotFound: () => Effect.succeed(providerNotFound(locale)),
        }),
      ),
    );
  });

/**
 * One short request to a chat model before it is saved, so a wrong model ID
 * or key shows up in the dialog instead of in someone's first chat.
 */
export const testChatModel = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ProbeModelInput))
  .handler(({ data }) => {
    const locale = getLocale();
    return runServerFn(
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
          ModelNotFound: () => Effect.succeed(providerNotFound(locale)),
        }),
      ),
    );
  });
