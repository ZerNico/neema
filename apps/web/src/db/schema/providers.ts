import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type {
  ImageCapabilities,
  ImageFamily,
  PresetId,
  ProviderSettings,
} from "@chat/model-client";
import type {
  ImagePricing,
  ModelCapabilities,
  ModelPricing,
  ModelType,
} from "~/modules/providers/model-config.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * AI provider registry, managed by admins.
 */

export const providers = pgTable("providers", {
  id: text().primaryKey(),
  name: text().notNull(),
  // Which service it is: the preset holds its endpoint, wire format and quirks.
  preset: text().$type<PresetId>().notNull(),
  // What an admin changed from the preset, only keys the preset lets them change.
  settings: jsonb().$type<ProviderSettings>().notNull().default({}),
  baseUrl: text("base_url").notNull(),
  // AES-256-GCM encrypted with ENCRYPTION_KEY; never returned to clients.
  // Null for a self-hosted server that takes no key.
  apiKeyCiphertext: text("api_key_ciphertext"),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const models = pgTable(
  "models",
  {
    id: text().primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    // provider-side identifier, e.g. "anthropic/claude-sonnet-5"
    modelKey: text("model_key").notNull(),
    displayName: text("display_name").notNull(),
    /** Admin-written line under the name in model pickers, for people who don't know models. */
    description: text(),
    type: text({ enum: ["chat", "embedding", "image"] })
      .$type<ModelType>()
      .notNull(),
    // Selection priority only; null leaves this model in the alphabetical fallback.
    defaultPriority: integer("default_priority"),
    contextLength: integer("context_length"),
    embeddingDimensions: integer("embedding_dimensions"),
    // Auto-detected from the provider catalog where possible, admin-overridable.
    capabilities: jsonb()
      .$type<ModelCapabilities>()
      .notNull()
      .default({ imageOutput: false, reasoning: false, tools: false, vision: false, files: false }),
    // The API this model is called on, where its preset lets models differ
    // (Azure). Set by an admin or by a refusal of Responses; null is the preset's.
    format: text({ enum: ["chat-completions", "responses"] }),
    metadata: jsonb().$type<Record<string, JsonValue>>(),
    // USD per 1M tokens; prefilled from the provider catalog where it carries
    // prices (OpenRouter), admin-editable. Null = unknown, so usage costs then
    // rely on provider-reported numbers or stay unknown.
    pricing: jsonb().$type<ModelPricing>(),
    // Image models only, all three together (checked below). The family names
    // the adapter and its fixed limits, apart from the provider's model key,
    // since an Azure deployment name says nothing about the model behind it.
    imageFamily: text("image_family").$type<ImageFamily>(),
    // What an admin allows, clipped to the family's limits wherever it is read.
    imageCapabilities: jsonb("image_capabilities").$type<ImageCapabilities>(),
    // Its own column: every token-pricing reader stays untouched by image rows.
    imagePricing: jsonb("image_pricing").$type<ImagePricing>(),
    // "public": every user sees and can use it. "groups": only members of the
    // groups linked via model_group_access (admins always bypass).
    access: text({ enum: ["public", "groups"] })
      .notNull()
      .default("public"),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("models_provider_id_idx").on(t.providerId),
    check(
      "models_image_fields",
      sql`(${t.type} = 'image') = (${t.imageFamily} is not null and ${t.imageCapabilities} is not null)`,
    ),
    check("models_image_pricing", sql`${t.type} = 'image' or ${t.imagePricing} is null`),
  ],
);

/**
 * Instance-wide model choices that are not per chat. One row at most, keyed by
 * a constant so a second insert conflicts instead of creating a rival.
 */
export const modelSettings = pgTable("model_settings", {
  id: text().primaryKey(),
  // Side generations (chat titles) run on this model when set; null, or a
  // model that fails, falls back to the chat's own model.
  utilityModelId: text("utility_model_id").references(() => models.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const MODEL_SETTINGS_ID = "instance";
