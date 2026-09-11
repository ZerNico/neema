import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { JsonValue } from "./providers.ts";

// Instance-wide OAuth sign-in providers, managed by admins. The primary key is
// the id Better Auth registers the provider under, so it is also the last
// segment of the callback URL the admin pastes into the provider's console.

export const oauthProviders = pgTable("oauth_providers", {
  id: text().primaryKey(),
  // "builtin" for a provider Better Auth ships (id is its own key, e.g. "google"),
  // "oidc" for one reached through the generic-oauth plugin by discovery.
  kind: text().$type<"builtin" | "oidc">().notNull(),
  // button label on the sign-in page
  label: text().notNull(),
  enabled: boolean().notNull().default(false),
  clientId: text("client_id").notNull(),
  // AES-256-GCM via KeyCipher, like provider API keys
  clientSecretCiphertext: text("client_secret_ciphertext"),
  // non-secret extras; shape depends on kind (see modules/auth/oauth.ts)
  config: jsonb().$type<Record<string, JsonValue>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
