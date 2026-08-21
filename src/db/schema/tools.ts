import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { JsonValue } from "./providers.ts";

// Instance-wide tool registry, managed by admins. One row per tool; the
// web_search row is seeded (disabled) by migration.

export const tools = pgTable(
  "tools",
  {
    id: text().primaryKey(),
    // stable identifier the model calls the tool by, e.g. "web_search"
    name: text().notNull(),
    // implementation family, e.g. "web_search"; lets one name swap backends later
    kind: text().notNull(),
    enabled: boolean().notNull().default(false),
    // non-secret configuration; shape depends on kind (see modules/tools/schema.ts)
    config: jsonb().$type<Record<string, JsonValue>>().notNull(),
    // optional secret (e.g. SearXNG bearer token), AES-256-GCM via KeyCipher
    secretCiphertext: text("secret_ciphertext"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tools_name_idx").on(t.name)],
);
