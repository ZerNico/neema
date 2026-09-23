import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { user } from "./auth.ts";
import { conversations } from "./chat.ts";
import { groups } from "./groups.ts";

/**
 * Instance setup for one integration the code ships. The primary key is the
 * manifest id, so a row exists only for integrations an admin has touched;
 * without one an integration is simply off. Shared like custom tools: who may
 * connect is `audience` plus the grant tables below, admins always.
 */
export const integrationConfigs = pgTable("integration_configs", {
  id: text().primaryKey(),
  enabled: boolean().notNull().default(false),
  // Non-secret settings named by the manifest's admin fields (base URL…).
  config: jsonb().$type<Record<string, string>>().notNull().default({}),
  oauthClientId: text("oauth_client_id"),
  // AES-256-GCM via KeyCipher, like provider API keys
  oauthClientSecretCiphertext: text("oauth_client_secret_ciphertext"),
  allowApiKeys: boolean("allow_api_keys").notNull().default(true),
  audience: text({ enum: ["private", "instance"] })
    .notNull()
    .default("instance"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const integrationUserGrants = pgTable(
  "integration_user_grants",
  {
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.userId] })],
);

export const integrationGroupGrants = pgTable(
  "integration_group_grants",
  {
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.integrationId, t.groupId] })],
);

/**
 * One user's credentials for one integration. Everything the assistant does
 * through an integration runs as this account, so it is never shared: an
 * agent or a schedule only ever reaches the sender's own connection.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    authKind: text("auth_kind", { enum: ["oauth", "api_key"] }).notNull(),
    // KeyCipher over the JSON credential (token set or key); never leaves the server.
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    accountLabel: text("account_label").notNull(),
    // The instance config the credentials were issued against. A base URL
    // change makes them meaningless, so a mismatch reads as needing reauth.
    configFingerprint: text("config_fingerprint").notNull(),
    status: text({ enum: ["active", "needs_reauth"] })
      .notNull()
      .default("active"),
    offerByDefault: boolean("offer_by_default").notNull().default(true),
    // Per tool: "allow", "ask" or "block". A tool not listed keeps its
    // default (reads allowed, changes ask), so a new tool starts safe.
    toolPermissions: jsonb("tool_permissions")
      .$type<Record<string, "allow" | "ask" | "block">>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integration_connections_user_idx").on(t.userId, t.integrationId)],
);

/**
 * A chat's own choices over the connection's defaults: whether the
 * integration is offered, and which tools need no approval here. Branch
 * copies these; a one-off Allow is never stored, only "always allow in this
 * chat".
 */
export const conversationIntegrations = pgTable(
  "conversation_integrations",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    enabled: boolean(),
    // Tools the person said to always allow in this chat, from an approval.
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.integrationId] })],
);

/** An agent narrows the offer to what it attached; the sender's connection runs it. */
export const agentIntegrations = pgTable(
  "agent_integrations",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    integrationId: text("integration_id").notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.integrationId] }),
    index("agent_integrations_integration_idx").on(t.integrationId),
  ],
);
