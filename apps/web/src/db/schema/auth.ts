import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Better Auth core tables (+ admin plugin fields on user and session, and the
 * desktop-sessions plugin's `desktop` mark on session).
 * Column shapes must stay in sync with better-auth's Drizzle adapter expectations.
 */

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text(),
  role: text().notNull().default("user"),
  banned: boolean().notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    // The desktop-sessions plugin's field: set only when a ticket is redeemed.
    desktop: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text(),
    idToken: text("id_token"),
    password: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `@better-auth/oauth-provider` tables, through `@better-auth/mcp`: apps that
 * reach this instance as an MCP server. Opaque access tokens, so no `jwks`.
 * Better Auth declares no delete rule for a user or client reference; removing
 * either removes what it granted.
 */
const at = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text().primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean().default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text().array(),
    clientCredentialsScopes: text("client_credentials_scopes").array().default([]),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text().array(),
    tos: text(),
    policy: text(),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text(),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb(),
  },
  (t) => [index("oauth_client_user_id_idx").on(t.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean().default(false),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb(),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb(),
    createdAt: at("created_at"),
  },
  (t) => [
    index("oauth_client_resource_client_id_idx").on(t.clientId),
    index("oauth_client_resource_resource_id_idx").on(t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text().array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull(),
    revoked: at("revoked"),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_session_id_idx").on(t.sessionId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text().array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    // A refresh token's revocation takes the access tokens it minted with it.
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: at("expires_at").notNull(),
    createdAt: at("created_at").notNull(),
    revoked: at("revoked"),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_session_id_idx").on(t.sessionId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_authorization_code_id_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text().array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text().array().notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    index("oauth_consent_client_id_idx").on(t.clientId),
    index("oauth_consent_user_id_idx").on(t.userId),
  ],
);

/** One row per `private_key_jwt` assertion id, so a replay collides on the key. */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text().primaryKey(),
  expiresAt: at("expires_at").notNull(),
});
