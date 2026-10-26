import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema, type Redacted } from "effect";
import {
  DefaultModelIds,
  InvalidDefaultModelOrder,
  MAX_DEFAULT_MODELS,
  InvalidUtilityModel,
  markDefaultModel,
  UnhostedImageFamily,
} from "../default-models.ts";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import {
  MODEL_SETTINGS_ID,
  groupMembers,
  modelGroupAccess,
  modelSettings,
  models,
  providers,
  user,
} from "~/db/schema/index.ts";
import {
  actionableReasoningEfforts,
  normalizeModelSettings,
  type ModelFormat,
  type ModelSettings,
  type ReasoningEffort,
} from "../model-config.ts";
import {
  effectiveImageCapabilities,
  getPreset,
  imageFamiliesFor,
  resolveBaseUrl,
  sanitizeSettings,
  type PresetId,
  type ProviderSettings,
} from "@chat/model-client";
import { supportsImageOutput } from "../provider-presets.ts";
import { KeyCipher } from "./crypto.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

export type ModelRow = typeof models.$inferSelect;
export type ModelAccess = ModelRow["access"];
/** A model as the chat picker consumes it: only what the picker renders. */
export type ChatModelRow = Pick<
  ModelRow,
  "id" | "displayName" | "description" | "contextLength" | "capabilities"
> & {
  providerName: string;
  isDefault: boolean;
  reasoningEfforts?: ReasoningEffort[];
};
/** An image model as the composer's picker consumes it. */
export type ImageModelRow = Pick<
  ModelRow,
  "id" | "displayName" | "description" | "imageCapabilities"
> & {
  providerName: string;
  isDefault: boolean;
};
/** The model types an admin orders; embedding models have no default. */
export type OrderedModelType = "chat" | "image";
type ProviderRow = typeof providers.$inferSelect;
/** Provider rows with the ciphertext stripped, safe to send to admin clients. */
export type PublicProvider = Omit<ProviderRow, "apiKeyCiphertext"> & { hasApiKey: boolean };
export type ProviderWithKey = PublicProvider & { apiKey: Redacted.Redacted<string> | null };

// A family its provider's preset no longer hosts cannot be called.
const hostsFamily = (row: { imageFamily: string | null; preset: PresetId }) =>
  row.imageFamily !== null &&
  imageFamiliesFor(row.preset).some((family) => family.id === row.imageFamily);

const toPublic = ({ apiKeyCiphertext, ...rest }: ProviderRow): PublicProvider => ({
  ...rest,
  hasApiKey: apiKeyCiphertext !== null,
});

export class ProviderRepo extends Context.Service<
  ProviderRepo,
  {
    listProviders(): Effect.Effect<PublicProvider[]>;
    createProvider(input: {
      name: string;
      preset: PresetId;
      /** Blank or absent means the preset's endpoint; a preset without one must be given it. */
      baseUrl?: string;
      /** Absent or blank stores no key, for servers that take none. */
      apiKey?: string;
      /** Only what the preset lets an admin change is kept. */
      settings?: ProviderSettings;
    }): Effect.Effect<PublicProvider>;
    updateProvider(
      providerId: string,
      patch: Partial<{
        name: string;
        baseUrl: string;
        apiKey: string;
        enabled: boolean;
        /** Replaces the overrides; keys left out return to the preset's value. */
        settings: ProviderSettings;
      }>,
    ): Effect.Effect<void>;
    deleteProvider(providerId: string): Effect.Effect<void>;
    /** Internal: full row incl. decrypted key, for the AI gateway only. */
    getProviderWithKey(providerId: string): Effect.Effect<ProviderWithKey | null>;
    listModels(filter?: { providerId?: string; enabledOnly?: boolean }): Effect.Effect<ModelRow[]>;
    /**
     * The enabled chat models of enabled providers this user may see: public
     * ones, plus private ones shared with a group the user belongs to. Admins
     * see everything (but never models of a disabled provider).
     */
    listChatModelsFor(userId: string): Effect.Effect<ChatModelRow[]>;
    /** The same predicate for image models, in the admin's image order. */
    listImageModelsFor(userId: string): Effect.Effect<ImageModelRow[]>;
    /** Ranks one type's models; the other type's order is left as it is. */
    setDefaultModelOrder(
      modelIds: ReadonlyArray<string>,
      type?: OrderedModelType,
    ): Effect.Effect<void, InvalidDefaultModelOrder>;
    /** The model side generations prefer, or null to use each chat's own. */
    getUtilityModelId(): Effect.Effect<string | null>;
    setUtilityModelId(modelId: string | null): Effect.Effect<void, InvalidUtilityModel>;
    /** The model that checks computer calls under "ask when risky", or null for the chat's own. */
    getReviewModelId(): Effect.Effect<string | null>;
    setReviewModelId(modelId: string | null): Effect.Effect<void, InvalidUtilityModel>;
    /**
     * The model row when this user may use it as `type` right now, else null:
     * the listing's own predicate, so a listed model always passes and an
     * unlisted one never does.
     */
    usableModel(
      userId: string,
      modelId: string,
      type: OrderedModelType,
    ): Effect.Effect<ModelRow | null>;
    /** Sets access independently for internal callers and access-policy tests. */
    updateModelAccess(
      modelId: string,
      access: ModelAccess,
      groupIds: ReadonlyArray<string>,
    ): Effect.Effect<void>;
    listModelAccess(): Effect.Effect<Array<{ modelId: string; groupId: string }>>;
    getModel(modelId: string): Effect.Effect<ModelRow | null>;
    createModel(
      input: {
        providerId: string;
        modelKey: string;
        metadata?: Record<string, import("~/db/schema/providers.ts").JsonValue>;
      } & ModelSettings,
    ): Effect.Effect<ModelRow, UnhostedImageFamily>;
    /** Updates model settings and replaces allowed-group links atomically. */
    updateModel(modelId: string, input: ModelSettings): Effect.Effect<void, UnhostedImageFamily>;
    /** Records the API a model turned out to need, after it refused another. */
    setModelFormat(modelId: string, format: ModelFormat): Effect.Effect<void>;
    deleteModel(modelId: string): Effect.Effect<void>;
  }
>()("chat/providers/ProviderRepo") {
  static readonly layer = Layer.effect(
    ProviderRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      // Who may use a model: everyone when public, admins always, otherwise
      // members of a linked group. Evaluated in SQL so listing and the
      // per-request check can never drift apart.
      const accessibleBy = (userId: string) =>
        or(
          eq(models.access, "public"),
          exists(
            db
              .select({ one: sql`1` })
              .from(user)
              .where(and(eq(user.id, userId), eq(user.role, "admin"))),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(modelGroupAccess)
              .innerJoin(groupMembers, eq(groupMembers.groupId, modelGroupAccess.groupId))
              .where(and(eq(modelGroupAccess.modelId, models.id), eq(groupMembers.userId, userId))),
          ),
        );

      // What makes a model usable as `type`: the listings and `usableModel`
      // all filter on this, so they cannot disagree.
      const usableAs = (userId: string, type: OrderedModelType) =>
        and(
          eq(providers.enabled, true),
          eq(models.enabled, true),
          eq(models.type, type),
          accessibleBy(userId),
        );

      // The admin UI offers only the families a preset hosts; this is the
      // server's own refusal, so a stored family is always one it can call.
      const checkImageFamily = (
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        providerId: string,
        settings: { readonly type: string; readonly imageFamily?: string | null },
      ) =>
        Effect.gen(function* () {
          if (settings.type !== "image") return;
          const [provider] = yield* tx
            .select({ preset: providers.preset })
            .from(providers)
            .where(eq(providers.id, providerId));
          if (
            !provider ||
            !imageFamiliesFor(provider.preset).some((family) => family.id === settings.imageFamily)
          )
            return yield* new UnhostedImageFamily({
              reason: localized(m.providers_error_unhosted_family, {
                family: settings.imageFamily ?? "",
              }),
            });
        });

      /** One of the instance's model choices; see `modelSettings`. */
      const modelSetting = (column: "utilityModelId" | "reviewModelId") =>
        db
          .select({ id: modelSettings[column] })
          .from(modelSettings)
          .where(eq(modelSettings.id, MODEL_SETTINGS_ID))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows[0]?.id ?? null),
          );
      /** Sets one, refusing a model that is not a chat model; null clears it. */
      const setModelSetting = (
        column: "utilityModelId" | "reviewModelId",
        modelId: string | null,
      ) =>
        Effect.gen(function* () {
          if (modelId !== null) {
            const rows = yield* db
              .select({ type: models.type })
              .from(models)
              .where(eq(models.id, modelId))
              .pipe(Effect.orDie);
            if (rows[0]?.type !== "chat")
              return yield* new InvalidUtilityModel({
                reason: localized(m.providers_error_utility_not_chat),
              });
          }
          yield* db
            .insert(modelSettings)
            .values({ id: MODEL_SETTINGS_ID, [column]: modelId })
            .onConflictDoUpdate({
              target: modelSettings.id,
              set: { [column]: modelId, updatedAt: new Date() },
            })
            .pipe(Effect.orDie);
        });

      return ProviderRepo.of({
        listProviders: Effect.fn("ProviderRepo.listProviders")(function* () {
          const rows = yield* db.select().from(providers).orderBy(asc(providers.createdAt));
          return rows.map(toPublic);
        }, Effect.orDie),

        createProvider: Effect.fn("ProviderRepo.createProvider")(function* (input) {
          const preset = getPreset(input.preset);
          const baseUrl = resolveBaseUrl(preset, input.baseUrl);
          // The admin function refuses this first, with a reason a person can act on.
          if (!baseUrl) return yield* Effect.die(new Error(`${input.preset} needs a base URL`));
          const key = input.apiKey?.trim();
          const apiKeyCiphertext = key ? yield* cipher.encrypt(key) : null;
          const rows = yield* db
            .insert(providers)
            .values({
              id: uuidv7(),
              name: input.name,
              preset: input.preset,
              settings: sanitizeSettings(preset, input.settings),
              baseUrl,
              apiKeyCiphertext,
            })
            .returning()
            .pipe(Effect.orDie);
          return toPublic(rows[0]!);
        }),

        updateProvider: Effect.fn("ProviderRepo.updateProvider")(function* (providerId, patch) {
          const { apiKey, baseUrl, settings, ...rest } = patch;
          const apiKeyCiphertext = apiKey?.trim()
            ? yield* cipher.encrypt(apiKey.trim())
            : undefined;
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [row] = yield* tx
                  .select({ preset: providers.preset })
                  .from(providers)
                  .where(eq(providers.id, providerId));
                if (!row) return;
                const preset = getPreset(row.preset);
                // A cleared base URL falls back to the preset's endpoint.
                const resolved =
                  baseUrl === undefined
                    ? undefined
                    : (resolveBaseUrl(preset, baseUrl) ?? undefined);
                yield* tx
                  .update(providers)
                  .set({
                    ...rest,
                    ...(resolved ? { baseUrl: resolved } : {}),
                    ...(settings ? { settings: sanitizeSettings(preset, settings) } : {}),
                    ...(apiKeyCiphertext ? { apiKeyCiphertext } : {}),
                    updatedAt: new Date(),
                  })
                  .where(eq(providers.id, providerId));
                yield* notifyOnCommit(tx, {
                  scope: "internal",
                  event: { type: "knowledge.work", stage: "embedding" },
                });
              }),
            )
            .pipe(Effect.orDie);
        }),

        deleteProvider: Effect.fn("ProviderRepo.deleteProvider")(function* (providerId) {
          yield* db.delete(providers).where(eq(providers.id, providerId)).pipe(Effect.orDie);
        }),

        getProviderWithKey: Effect.fn("ProviderRepo.getProviderWithKey")(function* (providerId) {
          const rows = yield* db
            .select()
            .from(providers)
            .where(eq(providers.id, providerId))
            .pipe(Effect.orDie);
          const row = rows[0];
          if (!row) return null;
          const apiKey =
            row.apiKeyCiphertext === null ? null : yield* cipher.decrypt(row.apiKeyCiphertext);
          return { ...toPublic(row), apiKey };
        }),

        listModels: Effect.fn("ProviderRepo.listModels")(function* (filter) {
          let rows = yield* db
            .select()
            .from(models)
            .orderBy(asc(models.displayName))
            .pipe(Effect.orDie);
          if (filter?.providerId) rows = rows.filter((row) => row.providerId === filter.providerId);
          if (filter?.enabledOnly) rows = rows.filter((row) => row.enabled);
          return rows;
        }),

        listChatModelsFor: Effect.fn("ProviderRepo.listChatModelsFor")(function* (userId) {
          // Selects only what the picker renders: the full row would leak
          // provider-internal details (modelKey, metadata) to every user.
          const rows = yield* db
            .select({
              id: models.id,
              defaultPriority: models.defaultPriority,
              displayName: models.displayName,
              description: models.description,
              contextLength: models.contextLength,
              capabilities: models.capabilities,
              modelKey: models.modelKey,
              providerName: providers.name,
              preset: providers.preset,
              settings: providers.settings,
            })
            .from(models)
            .innerJoin(providers, eq(providers.id, models.providerId))
            .where(usableAs(userId, "chat"))
            // The admin's order; Postgres sorts nulls last on ascending, so a
            // model nobody has placed yet follows the placed ones alphabetically.
            .orderBy(asc(models.defaultPriority), asc(models.displayName), asc(models.id))
            .pipe(Effect.orDie);
          return markDefaultModel(rows).map(({ preset, settings, modelKey, ...model }) => ({
            ...model,
            // A model's image output works only where its provider asks for it.
            capabilities: supportsImageOutput({ preset, settings })
              ? model.capabilities
              : { ...model.capabilities, imageOutput: false },
            reasoningEfforts: actionableReasoningEfforts(
              model.capabilities,
              { preset, settings },
              modelKey,
            ),
          }));
        }),

        listImageModelsFor: Effect.fn("ProviderRepo.listImageModelsFor")(function* (userId) {
          const rows = yield* db
            .select({
              id: models.id,
              defaultPriority: models.defaultPriority,
              displayName: models.displayName,
              description: models.description,
              imageFamily: models.imageFamily,
              imageCapabilities: models.imageCapabilities,
              providerName: providers.name,
              preset: providers.preset,
            })
            .from(models)
            .innerJoin(providers, eq(providers.id, models.providerId))
            .where(usableAs(userId, "image"))
            .orderBy(asc(models.defaultPriority), asc(models.displayName), asc(models.id))
            .pipe(Effect.orDie);
          const usable = rows.filter(hostsFamily);
          return markDefaultModel(usable).map(({ imageFamily, preset: _, ...model }) => ({
            ...model,
            imageCapabilities:
              imageFamily && model.imageCapabilities
                ? effectiveImageCapabilities(imageFamily, model.imageCapabilities)
                : model.imageCapabilities,
          }));
        }),

        setDefaultModelOrder: Effect.fn("ProviderRepo.setDefaultModelOrder")(function* (
          input,
          type = "chat",
        ) {
          const modelIds = yield* Schema.decodeUnknownEffect(DefaultModelIds)(input).pipe(
            Effect.mapError(
              () =>
                new InvalidDefaultModelOrder({
                  reason: localized(m.providers_error_order_limit, { max: MAX_DEFAULT_MODELS }),
                }),
            ),
          );
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // Also serializes replacements of an empty order. Row locks on
                // ranked models alone would not protect that case.
                yield* tx.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${`chat.model-default-order.${type}`}, 0))`,
                );
                if (modelIds.length > 0) {
                  const selected = yield* tx
                    .select({ id: models.id, type: models.type })
                    .from(models)
                    .where(inArray(models.id, modelIds))
                    .orderBy(asc(models.id))
                    .for("update");
                  if (
                    selected.length !== modelIds.length ||
                    selected.some((model) => model.type !== type)
                  ) {
                    return yield* new InvalidDefaultModelOrder({
                      reason: localized(
                        type === "image"
                          ? m.providers_error_order_not_image
                          : m.providers_error_order_not_chat,
                      ),
                    });
                  }
                }
                // A model left out of the list gets null from array_position.
                const rank = sql`array_position(array[${sql.join(
                  modelIds.map((id) => sql`${id}`),
                  sql`, `,
                )}]::text[], ${models.id}) - 1`;
                yield* tx
                  .update(models)
                  .set({ defaultPriority: rank, updatedAt: new Date() })
                  .where(eq(models.type, type));
              }),
            )
            .pipe(
              Effect.catch((error) =>
                error instanceof InvalidDefaultModelOrder ? Effect.fail(error) : Effect.die(error),
              ),
            );
        }),

        getUtilityModelId: Effect.fn("ProviderRepo.getUtilityModelId")(function* () {
          return yield* modelSetting("utilityModelId");
        }),

        setUtilityModelId: Effect.fn("ProviderRepo.setUtilityModelId")(function* (modelId) {
          yield* setModelSetting("utilityModelId", modelId);
        }),

        getReviewModelId: Effect.fn("ProviderRepo.getReviewModelId")(function* () {
          return yield* modelSetting("reviewModelId");
        }),

        setReviewModelId: Effect.fn("ProviderRepo.setReviewModelId")(function* (modelId) {
          yield* setModelSetting("reviewModelId", modelId);
        }),

        usableModel: Effect.fn("ProviderRepo.usableModel")(function* (userId, modelId, type) {
          const [row] = yield* db
            .select({ model: models, preset: providers.preset })
            .from(models)
            .innerJoin(providers, eq(providers.id, models.providerId))
            .where(and(eq(models.id, modelId), usableAs(userId, type)))
            .limit(1)
            .pipe(Effect.orDie);
          if (!row) return null;
          if (
            type === "image" &&
            !hostsFamily({ imageFamily: row.model.imageFamily, preset: row.preset })
          )
            return null;
          return row.model;
        }),

        updateModelAccess: Effect.fn("ProviderRepo.updateModelAccess")(
          function* (modelId, access, groupIds) {
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx
                    .update(models)
                    .set({ access, updatedAt: new Date() })
                    .where(eq(models.id, modelId));
                  yield* tx.delete(modelGroupAccess).where(eq(modelGroupAccess.modelId, modelId));
                  if (access === "groups" && groupIds.length > 0) {
                    yield* tx
                      .insert(modelGroupAccess)
                      .values(groupIds.map((groupId) => ({ modelId, groupId })));
                  }
                }),
              )
              .pipe(Effect.orDie);
          },
        ),

        listModelAccess: Effect.fn("ProviderRepo.listModelAccess")(function* () {
          return yield* db
            .select({ modelId: modelGroupAccess.modelId, groupId: modelGroupAccess.groupId })
            .from(modelGroupAccess)
            .pipe(Effect.orDie);
        }),

        getModel: Effect.fn("ProviderRepo.getModel")(function* (modelId) {
          const rows = yield* db
            .select()
            .from(models)
            .where(eq(models.id, modelId))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        createModel: Effect.fn("ProviderRepo.createModel")(function* (input) {
          const { providerId, modelKey, metadata, ...rawSettings } = input;
          const { groupIds, ...settings } = normalizeModelSettings(rawSettings);
          const modelId = uuidv7();

          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* checkImageFamily(tx, providerId, settings);
                const rows = yield* tx
                  .insert(models)
                  .values({ id: modelId, providerId, modelKey, metadata, ...settings })
                  .returning();
                if (settings.access === "groups" && groupIds.length > 0) {
                  yield* tx
                    .insert(modelGroupAccess)
                    .values(groupIds.map((groupId) => ({ modelId, groupId })));
                }
                return rows[0]!;
              }),
            )
            .pipe(
              Effect.catch((error) =>
                error instanceof UnhostedImageFamily ? Effect.fail(error) : Effect.die(error),
              ),
            );
        }),

        setModelFormat: Effect.fn("ProviderRepo.setModelFormat")(function* (modelId, format) {
          yield* db
            .update(models)
            .set({ format, updatedAt: new Date() })
            .where(eq(models.id, modelId))
            .pipe(Effect.orDie);
        }),

        updateModel: Effect.fn("ProviderRepo.updateModel")(function* (modelId, input) {
          const { groupIds, ...settings } = normalizeModelSettings(input);
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [current] = yield* tx
                  .select({ type: models.type, providerId: models.providerId })
                  .from(models)
                  .where(eq(models.id, modelId))
                  .for("update");
                if (!current) return;
                yield* checkImageFamily(tx, current.providerId, settings);
                yield* tx
                  .update(models)
                  .set({
                    ...settings,
                    // A rank belongs to one type's order; a new type starts unplaced.
                    ...(settings.type === "embedding" || settings.type !== current.type
                      ? { defaultPriority: null }
                      : {}),
                    updatedAt: new Date(),
                  })
                  .where(eq(models.id, modelId));
                // Replace wholesale: the editor submits the complete set, and
                // the lists are small enough that diffing buys nothing.
                yield* tx.delete(modelGroupAccess).where(eq(modelGroupAccess.modelId, modelId));
                if (settings.access === "groups" && groupIds.length > 0) {
                  yield* tx
                    .insert(modelGroupAccess)
                    .values(groupIds.map((groupId) => ({ modelId, groupId })));
                }
                yield* notifyOnCommit(tx, {
                  scope: "internal",
                  event: { type: "knowledge.work", stage: "embedding" },
                });
              }),
            )
            .pipe(
              Effect.catch((error) =>
                error instanceof UnhostedImageFamily ? Effect.fail(error) : Effect.die(error),
              ),
            );
        }),

        deleteModel: Effect.fn("ProviderRepo.deleteModel")(function* (modelId) {
          yield* db.delete(models).where(eq(models.id, modelId)).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
