import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// AI provider registry, managed by admins.

export const providers = pgTable("providers", {
  id: text().primaryKey(),
  name: text().notNull(),
  // wire protocol family: openrouter today, openai-compatible for generic endpoints
  kind: text({ enum: ["openrouter", "openai-compatible"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  // AES-256-GCM encrypted with PROVIDER_KEY_SECRET; never returned to clients
  apiKeyCiphertext: text("api_key_ciphertext").notNull(),
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
    type: text({ enum: ["chat", "embedding", "image", "audio"] }).notNull(),
    contextLength: integer("context_length"),
    // Auto-detected from the provider catalog where possible, admin-overridable.
    capabilities: jsonb()
      .$type<{ reasoning: boolean; tools: boolean; vision: boolean; files: boolean }>()
      .notNull()
      .default({ reasoning: false, tools: false, vision: false, files: false }),
    metadata: jsonb().$type<Record<string, JsonValue>>(),
    // "public": every user sees and can use it. "groups": only members of the
    // groups linked via model_group_access (admins always bypass).
    access: text({ enum: ["public", "groups"] })
      .notNull()
      .default("public"),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("models_provider_id_idx").on(t.providerId)],
);
