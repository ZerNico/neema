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
import { sql } from "drizzle-orm";
import { agents } from "./agents.ts";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";
import { groups } from "./groups.ts";
import type { McpToolEntry } from "~/modules/integrations/mcp/catalog.ts";

/**
 * One integration an admin set up: an instance of a type the code ships
 * (`kind`), so a server can have two Outlines or two Jira sites. The id is
 * chosen once and never changes, since tool names (`int_<id>__…`), the OAuth
 * callback and every stored reference carry it. Shared like custom tools: who
 * may connect is `audience` plus the grant tables below, admins always. A
 * personal MCP server has an owner instead: only they use and review it, and
 * its address must be public.
 */
export const integrationConfigs = pgTable(
  "integration_configs",
  {
    id: text().primaryKey(),
    /** The manifest and adapter it runs on. */
    kind: text().notNull(),
    /** What people see; unique among what one person sees, so an @mention names one integration. */
    name: text().notNull(),
    // Set for a server a person added for themselves; null for the admin's.
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "cascade" }),
    enabled: boolean().notNull().default(false),
    // Non-secret settings named by the manifest's admin fields (base URL…).
    config: jsonb().$type<Record<string, string>>().notNull().default({}),
    oauthClientId: text("oauth_client_id"),
    // AES-256-GCM via KeyCipher, like provider API keys
    oauthClientSecretCiphertext: text("oauth_client_secret_ciphertext"),
    // The authorization server a discovered sign-in first used the admin's client
    // with; its secret goes to no other. Cleared with each new revision.
    oauthClientIssuer: text("oauth_client_issuer"),
    // The adapter's fingerprint of `config` as last saved: which server, and how
    // people reach it. Compared under the row lock, never against a stale read.
    fingerprint: text(),
    // Which server this is, as a number: bumped whenever the fingerprint or the
    // admin's client changes. Work that started under one revision (a check, a
    // review, a sign-in, a prepared call) may only finish under the same one.
    revision: integer().notNull().default(1),
    allowApiKeys: boolean("allow_api_keys").notNull().default(true),
    // A key the admin holds for everyone, as the manifest's shared credential
    // fields (KeyCipher JSON). Only a type whose calls cannot act as anyone has one.
    sharedCredentialCiphertext: text("shared_credential_ciphertext"),
    audience: text({ enum: ["private", "instance"] })
      .notNull()
      .default("instance"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("integration_configs_name_idx").on(
      sql`coalesce(${t.ownerUserId}, '')`,
      sql`lower(${t.name})`,
    ),
    index("integration_configs_owner_idx").on(t.ownerUserId),
  ],
);

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
 * One account of one person on one integration. Everything the assistant does
 * through it runs as this account, so it is never shared: an agent or a
 * schedule only ever reaches the sender's own. A person may connect several
 * accounts (work and personal mail); chats, grants, allowances and knowledge
 * sources name the connection, never the integration alone.
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
    // `none` and `shared` hold no personal secret: the row keeps the person's
    // own toggles and tool permissions for a service everyone reaches alike.
    authKind: text("auth_kind", { enum: ["oauth", "api_key", "none", "shared"] }).notNull(),
    // KeyCipher over the JSON credential (token set or key); never leaves the server.
    credentialsCiphertext: text("credentials_ciphertext").notNull(),
    // Reconnect changes account identity. Refresh changes only the credential revision.
    accountEpoch: text("account_epoch")
      .notNull()
      .default(sql`gen_random_uuid()::text`),
    credentialRevision: text("credential_revision")
      .notNull()
      .default(sql`gen_random_uuid()::text`),
    accountLabel: text("account_label").notNull(),
    // The service's own id for the account, when it has one, so signing in to
    // the same account again reconnects this row instead of adding another.
    accountKey: text("account_key"),
    // The person's name for it ("Work"); null shows the account label.
    name: text(),
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
    // The manifest scope's items (Jira project keys) every call stays inside;
    // null is everything the account can reach.
    scope: jsonb().$type<string[]>(),
    // OAuth scopes a call was refused for, until the person signs in again
    // granting them; null when nothing is missing.
    requiredScopes: jsonb("required_scopes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("integration_connections_user_idx").on(t.userId, t.integrationId),
    uniqueIndex("integration_connections_account_idx")
      .on(t.userId, t.integrationId, t.accountKey)
      .where(sql`${t.accountKey} is not null`),
    // Using it without an account is the same for every such row, so one is enough.
    uniqueIndex("integration_connections_open_idx")
      .on(t.userId, t.integrationId)
      .where(sql`${t.authKind} in ('none', 'shared')`),
  ],
);

/**
 * A chat's own choices over an account's defaults: whether it is offered, and
 * which tools need no approval here. Branch copies these; a one-off Allow is
 * never stored, only "always allow in this chat".
 */
export const conversationIntegrations = pgTable(
  "conversation_integrations",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    enabled: boolean(),
    // Tools the person said to always allow in this chat, from an approval.
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.connectionId] }),
    index("conversation_integrations_connection_idx").on(t.connectionId),
  ],
);

/** An agent narrows the offer to what it attached; the sender's connection runs it. */
export const agentIntegrations = pgTable(
  "agent_integrations",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.integrationId] }),
    index("agent_integrations_integration_idx").on(t.integrationId),
  ],
);

/**
 * How many calls of one answer went out under an allowance, counted before
 * each is sent. Kept per answer rather than in memory so a resumed answer
 * cannot start over; a call whose outcome is unknown keeps its count.
 */
export const integrationAllowanceUses = pgTable(
  "integration_allowance_uses",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // Per account: a cap on what one run sends from work mail is not shared with personal.
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    allowanceId: text("allowance_id").notNull(),
    uses: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.connectionId, t.allowanceId] }),
    index("integration_allowance_uses_connection_idx").on(t.connectionId),
  ],
);

/**
 * The tools of an integration whose type reads them from its server (MCP).
 * Only `approved` is offered, in its order: a tool new or changed since waits
 * in `latest` until an admin approves it, so a server cannot put words in the
 * model's mouth unreviewed.
 */
export const integrationToolCatalogs = pgTable(
  "integration_tool_catalogs",
  {
    integrationId: text("integration_id")
      .primaryKey()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    approved: jsonb().$type<McpToolEntry[]>().notNull().default([]),
    // What the server listed at the last check that worked; null before one.
    latest: jsonb().$type<McpToolEntry[]>(),
    // What the server says about itself, for the admin.
    server: jsonb().$type<Record<string, string>>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkError: text("check_error"),
    // Whose connection the background check lists tools with.
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    // A claimed check's lease; the sweep skips a catalog until it lapses.
    checkLeaseUntil: timestamp("check_lease_until", { withTimezone: true }),
    // The newest check started. Only it may record what it saw, so a slower,
    // older listing never overwrites a newer one or one for another address.
    checkToken: text("check_token"),
    // Names the listing in `latest`: a new one per recorded check, null when
    // there is none. A review approves exactly this listing.
    listingId: text("listing_id"),
    // Counts approvals, so two admins reviewing at once cannot both win.
    reviewSeq: integer("review_seq").notNull().default(0),
  },
  (t) => [index("integration_tool_catalogs_due_idx").on(t.nextCheckAt)],
);

/**
 * An OAuth client this app registered with one authorization server, keyed
 * by its issuer: credentials one issuer gave are never shown to another, and
 * a server that moves to another issuer gets a fresh registration.
 */
export const integrationOAuthClients = pgTable(
  "integration_oauth_clients",
  {
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationConfigs.id, { onDelete: "cascade" }),
    issuer: text().notNull(),
    clientId: text("client_id").notNull(),
    // KeyCipher; null for a public client (a metadata document, or none issued).
    clientSecretCiphertext: text("client_secret_ciphertext"),
    method: text({ enum: ["metadata_document", "dynamic"] }).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One row per client, never overwritten: a sign-in under way, or a connection
  // refreshing, keeps finding the secret of the client it used.
  (t) => [primaryKey({ columns: [t.integrationId, t.issuer, t.clientId] })],
);
