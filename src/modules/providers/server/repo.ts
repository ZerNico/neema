import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, type Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import { models, providers } from "~/db/schema/index.ts";
import { KeyCipher } from "./crypto.ts";

export type ProviderKind = "openrouter" | "openai-compatible";
export type ModelType = "chat" | "embedding" | "image" | "audio";

export type ModelRow = typeof models.$inferSelect;
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
    getModel(modelId: string): Effect.Effect<ModelRow | null>;
    createModel(input: {
      providerId: string;
      modelKey: string;
      displayName: string;
      type: ModelType;
      contextLength?: number;
      capabilities?: { reasoning: boolean; tools: boolean; vision: boolean };
      metadata?: Record<string, import("~/db/schema/providers.ts").JsonValue>;
    }): Effect.Effect<ModelRow>;
    updateModel(
      modelId: string,
      patch: Partial<{
        displayName: string;
        type: ModelType;
        contextLength: number;
        capabilities: { reasoning: boolean; tools: boolean; vision: boolean };
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
