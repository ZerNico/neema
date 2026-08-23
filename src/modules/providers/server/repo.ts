import { and, asc, eq, exists, getTableColumns, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, type Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { groupMembers, modelGroupAccess, models, providers, user } from "~/db/schema/index.ts";
import { KeyCipher } from "./crypto.ts";

export type ProviderKind = "openrouter" | "openai-compatible";
export type ModelType = "chat" | "embedding" | "image" | "audio";

export type ModelRow = typeof models.$inferSelect;
export type ModelAccess = ModelRow["access"];
/** A model as the chat picker consumes it: its row plus the provider's name. */
export type ChatModelRow = ModelRow & { providerName: string };
type ProviderRow = typeof providers.$inferSelect;
// Provider rows with the ciphertext stripped — safe to send to admin clients.
export type PublicProvider = Omit<ProviderRow, "apiKeyCiphertext">;
export type ProviderWithKey = PublicProvider & { apiKey: Redacted.Redacted<string> };

const toPublic = ({ apiKeyCiphertext: _, ...rest }: ProviderRow): PublicProvider => rest;

export class ProviderRepo extends Context.Service<
  ProviderRepo,
  {
    listProviders(): Effect.Effect<PublicProvider[]>;
    createProvider(input: {
      name: string;
      kind: ProviderKind;
      baseUrl: string;
      apiKey: string;
    }): Effect.Effect<PublicProvider>;
    updateProvider(
      providerId: string,
      patch: Partial<{ name: string; baseUrl: string; apiKey: string; enabled: boolean }>,
    ): Effect.Effect<void>;
    deleteProvider(providerId: string): Effect.Effect<void>;
    // Internal: full row incl. decrypted key, for the AI gateway only.
    getProviderWithKey(providerId: string): Effect.Effect<ProviderWithKey | null>;
    listModels(filter?: { providerId?: string; enabledOnly?: boolean }): Effect.Effect<ModelRow[]>;
    /**
     * The enabled chat models this user may see: public ones, plus private
     * ones shared with a group the user belongs to. Admins see everything.
     */
    listChatModelsFor(userId: string): Effect.Effect<ChatModelRow[]>;
    /** Same predicate as listChatModelsFor, for one model (any type/state). */
    isModelAccessible(userId: string, modelId: string): Effect.Effect<boolean>;
    /** Atomically sets access and replaces the allowed-group links. */
    updateModelAccess(
      modelId: string,
      access: ModelAccess,
      groupIds: ReadonlyArray<string>,
    ): Effect.Effect<void>;
    listModelAccess(): Effect.Effect<Array<{ modelId: string; groupId: string }>>;
    getModel(modelId: string): Effect.Effect<ModelRow | null>;
    createModel(input: {
      providerId: string;
      modelKey: string;
      displayName: string;
      type: ModelType;
      contextLength?: number;
      capabilities?: { reasoning: boolean; tools: boolean; vision: boolean; files: boolean };
      metadata?: Record<string, import("~/db/schema/providers.ts").JsonValue>;
    }): Effect.Effect<ModelRow>;
    updateModel(
      modelId: string,
      patch: Partial<{
        displayName: string;
        type: ModelType;
        contextLength: number;
        capabilities: { reasoning: boolean; tools: boolean; vision: boolean; files: boolean };
        enabled: boolean;
      }>,
    ): Effect.Effect<void>;
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

      return ProviderRepo.of({
        listProviders: Effect.fn("ProviderRepo.listProviders")(function* () {
          const rows = yield* db.select().from(providers).orderBy(asc(providers.createdAt));
          return rows.map(toPublic);
        }, Effect.orDie),

        createProvider: Effect.fn("ProviderRepo.createProvider")(function* (input) {
          const apiKeyCiphertext = yield* cipher.encrypt(input.apiKey);
          const rows = yield* db
            .insert(providers)
            .values({
              id: uuidv7(),
              name: input.name,
              kind: input.kind,
              baseUrl: input.baseUrl,
              apiKeyCiphertext,
            })
            .returning()
            .pipe(Effect.orDie);
          return toPublic(rows[0]!);
        }),

        updateProvider: Effect.fn("ProviderRepo.updateProvider")(function* (providerId, patch) {
          const { apiKey, ...rest } = patch;
          const apiKeyCiphertext = apiKey ? yield* cipher.encrypt(apiKey) : undefined;
          yield* db
            .update(providers)
            .set({
              ...rest,
              ...(apiKeyCiphertext ? { apiKeyCiphertext } : {}),
              updatedAt: new Date(),
            })
            .where(eq(providers.id, providerId))
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
          const apiKey = yield* cipher.decrypt(row.apiKeyCiphertext);
          return { ...toPublic(row), apiKey };
        }),

        listModels: Effect.fn("ProviderRepo.listModels")(function* (filter) {
          let rows = yield* db
            .select()
            .from(models)
            .orderBy(asc(models.displayName))
            .pipe(Effect.orDie);
          if (filter?.providerId) rows = rows.filter((m) => m.providerId === filter.providerId);
          if (filter?.enabledOnly) rows = rows.filter((m) => m.enabled);
          return rows;
        }),

        listChatModelsFor: Effect.fn("ProviderRepo.listChatModelsFor")(function* (userId) {
          return yield* db
            .select({ ...getTableColumns(models), providerName: providers.name })
            .from(models)
            .innerJoin(providers, eq(providers.id, models.providerId))
            .where(and(eq(models.enabled, true), eq(models.type, "chat"), accessibleBy(userId)))
            .orderBy(asc(models.displayName))
            .pipe(Effect.orDie);
        }),

        isModelAccessible: Effect.fn("ProviderRepo.isModelAccessible")(function* (userId, modelId) {
          const rows = yield* db
            .select({ id: models.id })
            .from(models)
            .where(and(eq(models.id, modelId), accessibleBy(userId)))
            .limit(1)
            .pipe(Effect.orDie);
          return rows.length > 0;
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
                  // Replace wholesale: the editor submits the complete set, and
                  // the lists are small enough that diffing buys nothing.
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
          const rows = yield* db
            .insert(models)
            .values({ id: uuidv7(), ...input })
            .returning()
            .pipe(Effect.orDie);
          return rows[0]!;
        }),

        updateModel: Effect.fn("ProviderRepo.updateModel")(function* (modelId, patch) {
          yield* db
            .update(models)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(models.id, modelId))
            .pipe(Effect.orDie);
        }),

        deleteModel: Effect.fn("ProviderRepo.deleteModel")(function* (modelId) {
          yield* db.delete(models).where(eq(models.id, modelId)).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
