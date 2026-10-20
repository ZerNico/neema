import { leaseFor } from "~/server/sql.ts";
import type { ToolSetting } from "../manifest.ts";
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { IntegrationNotAvailable, type CredentialIdentity } from "../errors.ts";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import {
  agentIntegrations,
  conversationAgents,
  conversationIntegrations,
  conversations,
  groupMembers,
  integrationAllowanceUses,
  integrationConfigs,
  integrationConnections,
  integrationGroupGrants,
  integrationOAuthClients,
  integrationToolListings,
  integrationUserGrants,
  knowledgeCollections,
  knowledgeSources,
  schedules,
  user,
} from "~/db/schema/index.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import type { ToolPermission } from "../consent.ts";
import { NO_ACCOUNT_KINDS, usesNoAccount } from "../schema.ts";
import type { McpToolEntry } from "../mcp/catalog.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db, type DbTx } from "~/server/db.ts";

export type IntegrationConfigRow = typeof integrationConfigs.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;
export type ToolListingRow = typeof integrationToolListings.$inferSelect;
export type AuthKind = IntegrationConnectionRow["authKind"];

/** Scopes a connection may be waiting to be granted, in all. */
const MAX_REQUIRED_SCOPES = 50;

/**
 * Where a sign-in's tokens come from when the type found it at sign-in
 * (MCP), so a refresh needs no second discovery. Public facts, encrypted
 * with the tokens only because they travel together.
 */
const DiscoveredServer = Schema.Struct({
  issuer: Schema.String,
  /** The authorization server's metadata as validated at sign-in. */
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  /** The MCP server the tokens are bound to (RFC 8707). */
  resource: Schema.String,
  clientId: Schema.String,
  /** What was asked for; a step-up asks for these and what was missing. */
  scopes: Schema.Array(Schema.String),
});
export type DiscoveredServer = typeof DiscoveredServer.Type;

/** What a connection stores, encrypted as one JSON document. */
const StoredCredentials = Schema.Union([
  /** The manifest's API key fields as `readFields` returned them. */
  Schema.Struct({
    kind: Schema.Literal("api_key"),
    values: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    accessToken: Schema.String,
    refreshToken: Schema.NullOr(Schema.String),
    /** Epoch milliseconds; null when the service gave no lifetime. */
    expiresAt: Schema.NullOr(Schema.Number),
    server: Schema.optionalKey(DiscoveredServer),
  }),
  /** Nothing personal: a service everyone reaches alike, or through the admin's key. */
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type StoredCredentials = typeof StoredCredentials.Type;
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCredentials));
const decodeShared = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
/** A type's own kind for its first integration, then numbered: `jira`, `jira-2`. */
const freeId = (kind: string, taken: ReadonlyArray<string>) => {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
};

/**
 * Who may connect: everyone signed in when the audience is the instance,
 * admins always, otherwise a user or group grant. A personal server only its
 * owner, while they may still add their own. SQL, so the settings list,
 * connect and every attempt apply the same rule.
 */
export const integrationUsableBy = (
  userId: string,
): SQL => sql`(case when ${integrationConfigs.ownerUserId} is null then (
  ${integrationConfigs.audience} = 'instance'
  or exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')
  or exists(select 1 from ${integrationUserGrants} where ${integrationUserGrants.integrationId} = ${integrationConfigs.id} and ${integrationUserGrants.userId} = ${userId})
  or exists(select 1 from ${integrationGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${integrationGroupGrants.groupId}
    where ${integrationGroupGrants.integrationId} = ${integrationConfigs.id} and ${groupMembers.userId} = ${userId})
) else (
  ${integrationConfigs.ownerUserId} = ${userId}
  and ${capabilityAllowedSql(integrationConfigs.ownerUserId, "mcpServers")}
) end)`;

/** The admin's integrations, or one person's own servers. */
const ownedBy = (ownerUserId: string | null) =>
  ownerUserId === null
    ? isNull(integrationConfigs.ownerUserId)
    : eq(integrationConfigs.ownerUserId, ownerUserId);

export interface SaveConfig {
  readonly id: string;
  readonly name: string;
  /** Absent keeps the stored one; null clears it. */
  readonly description?: string | null | undefined;
  readonly enabled: boolean;
  readonly config: Record<string, string>;
  readonly fingerprint: string;
  readonly oauthClientId: string | null;
  /** Absent keeps the stored secret; empty string clears it. */
  readonly oauthClientSecret?: string | undefined;
  readonly allowApiKeys: boolean;
  /** The shared credential's fields; absent keeps what is stored, null clears it. */
  readonly sharedCredential?: Record<string, string> | null | undefined;
  /** Its tools come from the server, so another server's listings are dropped. */
  readonly listsTools: boolean;
}

export interface StoredOAuthClient {
  clientId: string;
  clientSecret: string | null;
  method: "metadata_document" | "dynamic";
  redirectUri: string;
}

export interface AllowanceUse {
  messageId: string;
  connectionId: string;
  allowanceId: string;
}

export class IntegrationRepo extends Context.Service<
  IntegrationRepo,
  {
    /** The admin's integrations, or with an owner, that person's own servers. */
    listConfigs(
      ownerUserId?: string | null,
    ): Effect.Effect<ReadonlyArray<IntegrationConfigRow & { connectionCount: number }>>;
    getConfig(id: string): Effect.Effect<IntegrationConfigRow | null>;
    /** The OAuth client secret, decrypted, for the token endpoint only. */
    clientSecret(row: IntegrationConfigRow): Effect.Effect<string | null>;
    /**
     * Saves instance setup. A changed fingerprint (another base URL) marks
     * every connection for reconnecting: its credentials name another server.
     */
    saveConfig(input: SaveConfig): Effect.Effect<IntegrationConfigRow | null>;
    /** A new integration, off and unconfigured; false when the id or name is taken. */
    /**
     * Adds an integration under the first free id of its type (`jira`, then
     * `jira-2`), or returns null when the name is already in use.
     */
    createConfig(input: {
      kind: string;
      name: string;
      ownerUserId?: string | null;
    }): Effect.Effect<string | null>;
    /**
     * Removes an integration with everything that only meant something with it
     * (connections, grants, chat and agent settings, through their foreign keys)
     * and takes it out of schedules. Refused while knowledge sources mirror it.
     */
    deleteConfig(
      id: string,
    ): Effect.Effect<{ deleted: true } | { deleted: false; sources: number }>;
    /** Whether another integration the owner would see uses this name, ignoring case. */
    nameTaken(
      name: string,
      exceptId: string | null,
      ownerUserId: string | null,
    ): Effect.Effect<boolean>;
    /** Integrations this person may use, enabled or not, with their accounts, oldest first. */
    listForUser(userId: string): Effect.Effect<
      ReadonlyArray<{
        config: IntegrationConfigRow;
        usable: boolean;
        connections: ReadonlyArray<IntegrationConnectionRow>;
      }>
    >;
    isUsable(userId: string, integrationId: string): Effect.Effect<boolean>;
    /** Whether this person may add MCP servers of their own. */
    mayAddServers(userId: string): Effect.Effect<boolean>;
    /** One of this person's accounts; null when it is not theirs or is gone. */
    getConnection(
      userId: string,
      connectionId: string,
    ): Effect.Effect<IntegrationConnectionRow | null>;
    getConnectionById(id: string): Effect.Effect<IntegrationConnectionRow | null>;
    /**
     * Null when the integration is no longer at `revision` (the credentials
     * were issued or verified under another setup), or the account named to
     * reconnect is not this person's; nothing is written then.
     */
    saveConnection(input: {
      userId: string;
      integrationId: string;
      revision: number;
      authKind: AuthKind;
      credentials: StoredCredentials;
      accountLabel: string;
      /** The service's id for the account; signing in to it again reconnects. */
      accountKey: string | null;
      fingerprint: string;
      /** The account being reconnected; otherwise the key or the way in decides. */
      connectionId?: string | null;
    }): Effect.Effect<IntegrationConnectionRow | null>;
    updatePreferences(
      userId: string,
      connectionId: string,
      input: {
        offerByDefault?: boolean;
        toolPermissions?: Record<string, ToolPermission>;
        /** Null lifts the limit. */
        scope?: string[] | null;
        /** Null goes back to the account label. */
        name?: string | null;
      },
    ): Effect.Effect<IntegrationConnectionRow | null>;
    removeConnection(userId: string, connectionId: string): Effect.Effect<void>;
    markNeedsReauth(credential: CredentialIdentity): Effect.Effect<void>;
    setConversationChoices(
      tx: DbTx,
      userId: string,
      conversationId: string,
      choices: ReadonlyArray<{ connectionId: string; enabled: boolean }>,
    ): Effect.Effect<void, IntegrationNotAvailable>;
    /** Null when the stored document is not one this version reads; the person reconnects. */
    decrypt(row: IntegrationConnectionRow): Effect.Effect<StoredCredentials | null>;
    encrypt(credentials: StoredCredentials): Effect.Effect<string>;
    /** What runs as this account: knowledge sources and schedules. */
    dependents(
      userId: string,
      connectionId: string,
    ): Effect.Effect<{ sources: number; schedules: number }>;
    /** A chat's own choices; empty for a chat that never overrode anything. */
    conversationSettings(
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<typeof conversationIntegrations.$inferSelect>>;
    /**
     * Upserts one chat's choice, only for the chat's owner. Null clears that
     * half of the override; false when the chat is not theirs.
     */
    setConversationSetting(
      userId: string,
      conversationId: string,
      connectionId: string,
      input: { enabled?: boolean | null; allowTool?: string },
    ): Effect.Effect<boolean>;
    /** The integrations a chat's installed agent attached, or null for plain chat. */
    agentIntegrationIds(conversationId: string): Effect.Effect<ReadonlyArray<string> | null>;
    /** The admin's shared credential, decrypted, for the adapter only. */
    sharedCredential(row: IntegrationConfigRow): Effect.Effect<Record<string, string> | null>;
    /** Clears the scopes calls were refused for, once a sign-in asked for them. */
    clearRequiredScopes(connectionId: string): Effect.Effect<void>;
    /**
     * Adds scopes a call was refused for to what the next sign-in asks for,
     * only while the connection is still the sign-in that call used.
     */
    addRequiredScopes(
      connection: { connectionId: string; accountEpoch: string },
      scopes: ReadonlyArray<string>,
    ): Effect.Effect<void>;
    /** One account's listing, or with `connectionId` null the one without an account. */
    toolListing(
      integrationId: string,
      connectionId: string | null,
    ): Effect.Effect<ToolListingRow | null>;
    /** Every listing of an integration, for the admin's view of its tools. */
    toolListings(integrationId: string): Effect.Effect<ReadonlyArray<ToolListingRow>>;
    /** Claims listings due for a check under a lease, so two sweeps never take the same one. */
    claimDueListings(input: {
      kinds: ReadonlyArray<string>;
      limit: number;
      leaseMs: number;
    }): Effect.Effect<ReadonlyArray<ToolListingRow>>;
    /**
     * Starts a check, sweep or manual, and returns its token. Starting one
     * supersedes any still running: only the newest may record what it saw.
     * Null when the integration or the account is gone.
     */
    startListing(integrationId: string, connectionId: string | null): Effect.Effect<string | null>;
    /** False when a newer check, or another revision of the integration, superseded this one. */
    recordListing(
      listingId: string,
      started: { token: string; revision: number },
      outcome: { tools: McpToolEntry[]; server: Record<string, string> } | { error: string },
      nextCheckAt: Date,
    ): Effect.Effect<boolean>;
    /** Drops one listing, as when its way in closed and it could only fail from then on. */
    deleteToolListing(integrationId: string, connectionId: string | null): Effect.Effect<void>;
    /** Sets or, with null, clears the admin's word on one tool; false when the integration is gone. */
    setToolSetting(
      integrationId: string,
      tool: string,
      setting: ToolSetting | null,
    ): Effect.Effect<boolean>;
    /** The client this app registered with an issuer under this id, if it did. */
    oauthClient(
      integrationId: string,
      issuer: string,
      clientId: string,
    ): Effect.Effect<StoredOAuthClient | null>;
    /** The newest client registered with an issuer for this redirect, to sign in with again. */
    reusableOAuthClient(
      integrationId: string,
      issuer: string,
      redirectUri: string,
    ): Effect.Effect<StoredOAuthClient | null>;
    /**
     * Pins the admin's client to an issuer unless it already is, atomically,
     * and returns the issuer it is pinned to. Null when the integration is no
     * longer at `revision`: the sign-in started under another setup.
     */
    pinClientIssuer(
      integrationId: string,
      revision: number,
      issuer: string,
    ): Effect.Effect<string | null>;
    saveOAuthClient(
      integrationId: string,
      issuer: string,
      client: StoredOAuthClient,
    ): Effect.Effect<void>;
    /** Takes one use of an allowance for an answer; false once it reached `cap`. */
    reserveAllowance(input: AllowanceUse & { cap: number }): Effect.Effect<boolean>;
    /** Gives back a use whose call certainly sent nothing. */
    releaseAllowance(input: AllowanceUse): Effect.Effect<void>;
  }
>()("chat/integrations/IntegrationRepo") {
  static readonly layer = Layer.effect(
    IntegrationRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const storedClient = (row: typeof integrationOAuthClients.$inferSelect) =>
        Effect.gen(function* () {
          return {
            clientId: row.clientId,
            clientSecret: row.clientSecretCiphertext
              ? Redacted.value(yield* cipher.decrypt(row.clientSecretCiphertext))
              : null,
            method: row.method,
            redirectUri: row.redirectUri,
          } satisfies StoredOAuthClient;
        });

      const decrypt = (row: IntegrationConnectionRow) =>
        cipher
          .decrypt(row.credentialsCiphertext)
          .pipe(Effect.map((secret) => Option.getOrNull(decodeStored(Redacted.value(secret)))));

      const nameTaken = Effect.fn("IntegrationRepo.nameTaken")(function* (
        name: string,
        exceptId: string | null,
        ownerUserId: string | null,
      ) {
        const rows = yield* db
          .select({ id: integrationConfigs.id })
          .from(integrationConfigs)
          .where(
            and(
              sql`lower(${integrationConfigs.name}) = lower(${name})`,
              exceptId ? sql`${integrationConfigs.id} <> ${exceptId}` : undefined,
              // A person sees the admin's integrations beside their own, so theirs avoid both.
              ownerUserId === null ? ownedBy(null) : or(ownedBy(null), ownedBy(ownerUserId)),
            ),
          )
          .pipe(Effect.orDie);
        return rows.length > 0;
      });

      return IntegrationRepo.of({
        listConfigs: Effect.fn("IntegrationRepo.listConfigs")(function* (ownerUserId = null) {
          const rows = yield* db
            .select({
              config: integrationConfigs,
              // People, not accounts: one person may have several.
              connectionCount: sql<number>`(select count(distinct ${integrationConnections.userId})::int from ${integrationConnections} where ${integrationConnections.integrationId} = ${integrationConfigs.id})`,
            })
            .from(integrationConfigs)
            .where(ownedBy(ownerUserId))
            .pipe(Effect.orDie);
          return rows.map((row) => ({ ...row.config, connectionCount: row.connectionCount }));
        }),

        getConfig: Effect.fn("IntegrationRepo.getConfig")(function* (id) {
          const rows = yield* db
            .select()
            .from(integrationConfigs)
            .where(eq(integrationConfigs.id, id))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        clientSecret: Effect.fn("IntegrationRepo.clientSecret")(function* (row) {
          if (!row.oauthClientSecretCiphertext) return null;
          return Redacted.value(yield* cipher.decrypt(row.oauthClientSecretCiphertext));
        }),

        saveConfig: Effect.fn("IntegrationRepo.saveConfig")(function* (input) {
          const secret =
            input.oauthClientSecret === undefined
              ? undefined
              : input.oauthClientSecret === ""
                ? null
                : yield* cipher.encrypt(input.oauthClientSecret);
          const shared =
            input.sharedCredential === undefined
              ? undefined
              : input.sharedCredential === null
                ? null
                : yield* cipher.encrypt(JSON.stringify(input.sharedCredential));
          const now = new Date();
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // What changed is decided against the row as it is now, locked, so two
                // admins saving at once cannot each judge against what they read.
                const [current] = yield* tx
                  .select()
                  .from(integrationConfigs)
                  .where(eq(integrationConfigs.id, input.id))
                  .for("update");
                if (!current) return null;
                const anotherServer = current.fingerprint !== input.fingerprint;
                const anotherClient = current.oauthClientId !== input.oauthClientId;
                const rows = yield* tx
                  .update(integrationConfigs)
                  .set({
                    name: input.name,
                    ...(input.description === undefined ? {} : { description: input.description }),
                    enabled: input.enabled,
                    config: input.config,
                    fingerprint: input.fingerprint,
                    oauthClientId: input.oauthClientId,
                    ...(secret === undefined ? {} : { oauthClientSecretCiphertext: secret }),
                    ...(shared === undefined ? {} : { sharedCredentialCiphertext: shared }),
                    ...(anotherServer || anotherClient
                      ? { revision: current.revision + 1, oauthClientIssuer: null }
                      : {}),
                    allowApiKeys: input.allowApiKeys,
                    updatedAt: now,
                  })
                  .where(eq(integrationConfigs.id, input.id))
                  .returning();
                yield* tx
                  .update(integrationConnections)
                  .set({ status: "needs_reauth", updatedAt: now })
                  .where(
                    and(
                      eq(integrationConnections.integrationId, input.id),
                      sql`${integrationConnections.configFingerprint} <> ${input.fingerprint}`,
                    ),
                  );
                // What was listed was another server's; a check still running for it
                // finds its row gone and records nothing.
                if (anotherServer && input.listsTools)
                  yield* tx
                    .delete(integrationToolListings)
                    .where(eq(integrationToolListings.integrationId, input.id));
                return rows[0] ?? null;
              }),
            )
            .pipe(Effect.orDie);
        }),

        createConfig: Effect.fn("IntegrationRepo.createConfig")(function* (input) {
          // The id and the lowercased name are both unique, and either clash inserts
          // nothing: a taken name ends it, a taken id means another admin just added
          // one of this type, so the next free id is tried.
          for (;;) {
            const taken = yield* db
              .select({ id: integrationConfigs.id })
              .from(integrationConfigs)
              .pipe(Effect.orDie);
            const id = freeId(
              input.kind,
              taken.map((row) => row.id),
            );
            const rows = yield* db
              .insert(integrationConfigs)
              .values({
                id,
                kind: input.kind,
                name: input.name,
                ownerUserId: input.ownerUserId ?? null,
              })
              .onConflictDoNothing()
              .returning({ id: integrationConfigs.id })
              .pipe(Effect.orDie);
            if (rows.length) return id;
            if (yield* nameTaken(input.name, null, input.ownerUserId ?? null)) return null;
          }
        }),

        deleteConfig: Effect.fn("IntegrationRepo.deleteConfig")(function* (id) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [locked] = yield* tx
                  .select({ id: integrationConfigs.id })
                  .from(integrationConfigs)
                  .where(eq(integrationConfigs.id, id))
                  .for("update");
                if (!locked) return { deleted: true as const };
                const [sources] = yield* tx
                  .select({ value: count() })
                  .from(knowledgeSources)
                  .where(eq(knowledgeSources.integrationId, id));
                if (sources && sources.value > 0)
                  return { deleted: false as const, sources: sources.value };
                yield* tx
                  .update(schedules)
                  .set({
                    integrationGrants: sql`coalesce((select jsonb_agg(grant_entry) from jsonb_array_elements(${schedules.integrationGrants}) as grant_entry where grant_entry->>'integrationId' <> ${id}), '[]'::jsonb)`,
                  })
                  .where(
                    sql`${schedules.integrationGrants} @> ${JSON.stringify([{ integrationId: id }])}::jsonb`,
                  );
                yield* tx.delete(integrationConfigs).where(eq(integrationConfigs.id, id));
                return { deleted: true as const };
              }),
            )
            .pipe(Effect.orDie);
        }),

        nameTaken,

        listForUser: Effect.fn("IntegrationRepo.listForUser")(function* (userId) {
          const rows = yield* db
            .select({
              config: integrationConfigs,
              usable: sql<boolean>`${integrationUsableBy(userId)}`,
              connection: integrationConnections,
            })
            .from(integrationConfigs)
            .leftJoin(
              integrationConnections,
              and(
                eq(integrationConnections.integrationId, integrationConfigs.id),
                eq(integrationConnections.userId, userId),
              ),
            )
            .pipe(Effect.orDie);
          const byConfig = new Map<
            string,
            {
              config: IntegrationConfigRow;
              usable: boolean;
              connections: IntegrationConnectionRow[];
            }
          >();
          for (const row of rows) {
            let entry = byConfig.get(row.config.id);
            if (!entry)
              byConfig.set(
                row.config.id,
                (entry = { config: row.config, usable: Boolean(row.usable), connections: [] }),
              );
            if (row.connection) entry.connections.push(row.connection);
          }
          for (const entry of byConfig.values())
            entry.connections.sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
            );
          return [...byConfig.values()];
        }),

        mayAddServers: Effect.fn("IntegrationRepo.mayAddServers")(function* (userId) {
          const [row] = yield* db
            .select({ allowed: capabilityAllowedSql(userId, "mcpServers") })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          return Boolean(row?.allowed);
        }),

        isUsable: Effect.fn("IntegrationRepo.isUsable")(function* (userId, integrationId) {
          const rows = yield* db
            .select({ id: integrationConfigs.id })
            .from(integrationConfigs)
            .where(
              and(
                eq(integrationConfigs.id, integrationId),
                eq(integrationConfigs.enabled, true),
                integrationUsableBy(userId),
              ),
            )
            .pipe(Effect.orDie);
          return rows.length > 0;
        }),

        getConnection: Effect.fn("IntegrationRepo.getConnection")(function* (userId, connectionId) {
          const rows = yield* db
            .select()
            .from(integrationConnections)
            .where(
              and(
                eq(integrationConnections.id, connectionId),
                eq(integrationConnections.userId, userId),
              ),
            )
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        getConnectionById: Effect.fn("IntegrationRepo.getConnectionById")(function* (id) {
          const rows = yield* db
            .select()
            .from(integrationConnections)
            .where(eq(integrationConnections.id, id))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        saveConnection: Effect.fn("IntegrationRepo.saveConnection")(function* (input) {
          const credentialsCiphertext = yield* cipher.encrypt(JSON.stringify(input.credentials));
          const now = new Date();
          // Reconnecting keeps the person's preferences and name; only the
          // credentials and what they point at are replaced.
          const replaced = {
            authKind: input.authKind,
            credentialsCiphertext,
            accountLabel: input.accountLabel,
            ...(input.accountKey === null ? {} : { accountKey: input.accountKey }),
            configFingerprint: input.fingerprint,
            status: "active" as const,
            accountEpoch: uuidv7(),
            credentialRevision: uuidv7(),
            updatedAt: now,
          };
          const saved = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // The integration's row at the revision the credentials were issued
                // under, so a setup changed meanwhile writes nothing. Key share waits
                // out a save in flight (it locks for update) but not a refresh.
                const [setup] = yield* tx
                  .select({ id: integrationConfigs.id })
                  .from(integrationConfigs)
                  .where(
                    and(
                      eq(integrationConfigs.id, input.integrationId),
                      eq(integrationConfigs.revision, input.revision),
                    ),
                  )
                  .for("key share");
                if (!setup) return null;
                const mine = and(
                  eq(integrationConnections.userId, input.userId),
                  eq(integrationConnections.integrationId, input.integrationId),
                );
                let row: IntegrationConnectionRow | undefined;
                if (input.connectionId) {
                  [row] = yield* tx
                    .update(integrationConnections)
                    .set(replaced)
                    .where(and(mine, eq(integrationConnections.id, input.connectionId)))
                    .returning();
                  if (!row) return null;
                } else {
                  const values = {
                    id: uuidv7(),
                    userId: input.userId,
                    integrationId: input.integrationId,
                    authKind: input.authKind,
                    credentialsCiphertext,
                    accountLabel: input.accountLabel,
                    accountKey: input.accountKey,
                    configFingerprint: input.fingerprint,
                  };
                  // The same account again, or the one way without an account,
                  // reconnects what is there; anything else is another account.
                  [row] =
                    input.accountKey !== null
                      ? yield* tx
                          .insert(integrationConnections)
                          .values(values)
                          .onConflictDoUpdate({
                            target: [
                              integrationConnections.userId,
                              integrationConnections.integrationId,
                              integrationConnections.accountKey,
                            ],
                            targetWhere: sql`${integrationConnections.accountKey} is not null`,
                            set: replaced,
                          })
                          .returning()
                      : usesNoAccount(input.authKind)
                        ? yield* tx
                            .insert(integrationConnections)
                            .values(values)
                            .onConflictDoUpdate({
                              target: [
                                integrationConnections.userId,
                                integrationConnections.integrationId,
                              ],
                              // Literal, as the partial index says it: a bound list
                              // cannot be matched to the index's predicate.
                              targetWhere: sql`${integrationConnections.authKind} in ('none', 'shared')`,
                              set: replaced,
                            })
                            .returning()
                        : yield* tx.insert(integrationConnections).values(values).returning();
                }
                if (!row) return null;
                // An account of their own takes over from using it without one.
                if (!usesNoAccount(input.authKind))
                  yield* tx
                    .delete(integrationConnections)
                    .where(
                      and(mine, inArray(integrationConnections.authKind, [...NO_ACCOUNT_KINDS])),
                    );
                return row;
              }),
            )
            .pipe(Effect.orDie);
          if (!saved) return null;
          // What lost its account when that was disconnected (a knowledge source, a
          // schedule's grant) takes this one only while it is the person's only account
          // there: connecting again fixes it, and two accounts are never guessed between.
          const [{ accounts } = { accounts: 0 }] = yield* db
            .select({ accounts: count() })
            .from(integrationConnections)
            .where(
              and(
                eq(integrationConnections.userId, input.userId),
                eq(integrationConnections.integrationId, input.integrationId),
              ),
            )
            .pipe(Effect.orDie);
          if (accounts === 1) {
            yield* db
              .update(knowledgeSources)
              .set({ connectionId: saved.id })
              .where(
                and(
                  isNull(knowledgeSources.connectionId),
                  eq(knowledgeSources.integrationId, input.integrationId),
                  sql`${knowledgeSources.collectionId} in (select ${knowledgeCollections.id} from ${knowledgeCollections} where ${knowledgeCollections.userId} = ${input.userId})`,
                ),
              )
              .pipe(Effect.orDie);
            yield* db
              .update(schedules)
              .set({
                integrationGrants: sql`(select jsonb_agg(case when grant_entry->>'integrationId' = ${input.integrationId} and not exists (select 1 from ${integrationConnections} where ${integrationConnections.id} = grant_entry->>'connectionId') then jsonb_set(grant_entry, '{connectionId}', to_jsonb(${saved.id}::text)) else grant_entry end) from jsonb_array_elements(${schedules.integrationGrants}) as grant_entry)`,
              })
              .where(
                and(
                  eq(schedules.userId, input.userId),
                  sql`${schedules.integrationGrants} @> ${JSON.stringify([{ integrationId: input.integrationId }])}::jsonb`,
                ),
              )
              .pipe(Effect.orDie);
          }
          // Its sources resume within a tick instead of waiting out their hourly slot.
          yield* db
            .update(knowledgeSources)
            .set({ nextSyncAt: sql`now()` })
            .where(eq(knowledgeSources.connectionId, saved.id))
            .pipe(Effect.orDie);
          return saved;
        }),

        updatePreferences: Effect.fn("IntegrationRepo.updatePreferences")(
          function* (userId, connectionId, input) {
            const rows = yield* db
              .update(integrationConnections)
              .set({
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.offerByDefault === undefined
                  ? {}
                  : { offerByDefault: input.offerByDefault }),
                // Merged in SQL, so two quick changes to different tools both stay.
                ...(input.toolPermissions === undefined
                  ? {}
                  : {
                      toolPermissions: sql`${integrationConnections.toolPermissions} || ${JSON.stringify(input.toolPermissions)}::jsonb`,
                    }),
                ...(input.scope === undefined ? {} : { scope: input.scope }),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(integrationConnections.userId, userId),
                  eq(integrationConnections.id, connectionId),
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            return rows[0] ?? null;
          },
        ),

        removeConnection: Effect.fn("IntegrationRepo.removeConnection")(
          function* (userId, connectionId) {
            yield* db
              .delete(integrationConnections)
              .where(
                and(
                  eq(integrationConnections.userId, userId),
                  eq(integrationConnections.id, connectionId),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),

        markNeedsReauth: Effect.fn("IntegrationRepo.markNeedsReauth")(function* (credential) {
          yield* db
            .update(integrationConnections)
            .set({ status: "needs_reauth", updatedAt: new Date() })
            .where(
              and(
                eq(integrationConnections.id, credential.connectionId),
                eq(integrationConnections.accountEpoch, credential.accountEpoch),
                eq(integrationConnections.credentialRevision, credential.credentialRevision),
              ),
            )
            .pipe(Effect.orDie);
        }),

        setConversationChoices: Effect.fn("IntegrationRepo.setConversationChoices")(
          function* (tx, userId, conversationId, choices) {
            if (choices.length === 0) return;
            const ids = [...new Set(choices.map((choice) => choice.connectionId))].toSorted();
            // Only this person's own accounts, held while the choices go in.
            const accounts = yield* tx
              .select({
                id: integrationConnections.id,
                integrationId: integrationConnections.integrationId,
              })
              .from(integrationConnections)
              .where(
                and(
                  inArray(integrationConnections.id, ids),
                  eq(integrationConnections.userId, userId),
                ),
              )
              .orderBy(asc(integrationConnections.id))
              .for("share")
              .pipe(Effect.orDie);
            const missing = ids.find((id) => !accounts.some((account) => account.id === id));
            if (missing)
              return yield* new IntegrationNotAvailable({
                integrationId: null,
                connectionId: missing,
              });
            const [owned] = yield* tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(ownedConversationById(conversationId, userId))
              .pipe(Effect.orDie);
            if (!owned)
              return yield* new IntegrationNotAvailable({
                integrationId: accounts[0]!.integrationId,
              });
            for (const choice of choices)
              yield* tx
                .insert(conversationIntegrations)
                .values({
                  conversationId,
                  connectionId: choice.connectionId,
                  enabled: choice.enabled,
                })
                .onConflictDoUpdate({
                  target: [
                    conversationIntegrations.conversationId,
                    conversationIntegrations.connectionId,
                  ],
                  set: { enabled: choice.enabled, updatedAt: new Date() },
                })
                .pipe(Effect.orDie);
          },
        ),

        decrypt,
        encrypt: (credentials) => cipher.encrypt(JSON.stringify(credentials)),

        dependents: Effect.fn("IntegrationRepo.dependents")(function* (userId, connectionId) {
          const [sources] = yield* db
            .select({ total: count() })
            .from(knowledgeSources)
            .innerJoin(
              knowledgeCollections,
              eq(knowledgeCollections.id, knowledgeSources.collectionId),
            )
            .where(
              and(
                eq(knowledgeCollections.userId, userId),
                eq(knowledgeSources.connectionId, connectionId),
              ),
            )
            .pipe(Effect.orDie);
          const [scheduled] = yield* db
            .select({ total: count() })
            .from(schedules)
            .where(
              and(
                eq(schedules.userId, userId),
                sql`${schedules.integrationGrants} @> ${JSON.stringify([{ connectionId }])}::jsonb`,
              ),
            )
            .pipe(Effect.orDie);
          return { sources: Number(sources?.total ?? 0), schedules: Number(scheduled?.total ?? 0) };
        }),

        conversationSettings: Effect.fn("IntegrationRepo.conversationSettings")(
          function* (conversationId) {
            return yield* db
              .select()
              .from(conversationIntegrations)
              .where(eq(conversationIntegrations.conversationId, conversationId))
              .pipe(Effect.orDie);
          },
        ),

        setConversationSetting: Effect.fn("IntegrationRepo.setConversationSetting")(
          function* (userId, conversationId, connectionId, input) {
            const owned = yield* db
              .select({ id: conversations.id })
              .from(conversations)
              .where(ownedConversationById(conversationId, userId))
              .pipe(Effect.orDie);
            if (owned.length === 0) return false;
            // A chat's choice can only name its owner's own account.
            const account = yield* db
              .select({ id: integrationConnections.id })
              .from(integrationConnections)
              .where(
                and(
                  eq(integrationConnections.id, connectionId),
                  eq(integrationConnections.userId, userId),
                ),
              )
              .pipe(Effect.orDie);
            if (account.length === 0) return false;
            const set = {
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              updatedAt: new Date(),
            };
            const allowed = input.allowTool ? [input.allowTool] : [];
            yield* db
              .insert(conversationIntegrations)
              .values({ conversationId, connectionId, ...set, allowedTools: allowed })
              .onConflictDoUpdate({
                target: [
                  conversationIntegrations.conversationId,
                  conversationIntegrations.connectionId,
                ],
                set: input.allowTool
                  ? {
                      ...set,
                      // Appended in SQL so two approvals in one answer both stick.
                      allowedTools: sql`(select jsonb_agg(distinct tool) from jsonb_array_elements_text(${conversationIntegrations.allowedTools} || ${JSON.stringify(allowed)}::jsonb) as tool)`,
                    }
                  : set,
              })
              .pipe(Effect.orDie);
            return true;
          },
        ),

        agentIntegrationIds: Effect.fn("IntegrationRepo.agentIntegrationIds")(
          function* (conversationId) {
            const [installed] = yield* db
              .select({ agentId: conversationAgents.agentId })
              .from(conversationAgents)
              .where(eq(conversationAgents.conversationId, conversationId))
              .pipe(Effect.orDie);
            if (!installed?.agentId) return null;
            const rows = yield* db
              .select({ integrationId: agentIntegrations.integrationId })
              .from(agentIntegrations)
              .where(eq(agentIntegrations.agentId, installed.agentId))
              .orderBy(agentIntegrations.position)
              .pipe(Effect.orDie);
            return rows.map((row) => row.integrationId);
          },
        ),

        sharedCredential: Effect.fn("IntegrationRepo.sharedCredential")(function* (row) {
          if (!row.sharedCredentialCiphertext) return null;
          const plain = Redacted.value(yield* cipher.decrypt(row.sharedCredentialCiphertext));
          return Option.getOrNull(decodeShared(plain));
        }),

        clearRequiredScopes: Effect.fn("IntegrationRepo.clearRequiredScopes")(
          function* (connectionId) {
            yield* db
              .update(integrationConnections)
              .set({ requiredScopes: null, updatedAt: new Date() })
              .where(eq(integrationConnections.id, connectionId))
              .pipe(Effect.orDie);
          },
        ),

        addRequiredScopes: Effect.fn("IntegrationRepo.addRequiredScopes")(
          function* (connection, scopes) {
            // A union in one statement, so two refused calls at once both count. Past
            // MAX_REQUIRED_SCOPES in all, what was asked for before stands: a server
            // naming new scopes on every refusal cannot grow the row or the sign-in URL.
            yield* db
              .update(integrationConnections)
              .set({
                requiredScopes: sql`coalesce((select case when count(*) <= ${MAX_REQUIRED_SCOPES} then jsonb_agg(listed.scope order by listed.scope) end from (select distinct scope from jsonb_array_elements_text(coalesce(${integrationConnections.requiredScopes}, '[]'::jsonb) || ${JSON.stringify(scopes.slice(0, MAX_REQUIRED_SCOPES))}::jsonb) as joined(scope)) as listed), ${integrationConnections.requiredScopes})`,
              })
              .where(
                and(
                  eq(integrationConnections.id, connection.connectionId),
                  eq(integrationConnections.accountEpoch, connection.accountEpoch),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),

        toolListing: Effect.fn("IntegrationRepo.toolListing")(
          function* (integrationId, connectionId) {
            const rows = yield* db
              .select()
              .from(integrationToolListings)
              .where(eq(integrationToolListings.id, connectionId ?? integrationId))
              .pipe(Effect.orDie);
            return rows[0]?.integrationId === integrationId ? rows[0] : null;
          },
        ),

        toolListings: Effect.fn("IntegrationRepo.toolListings")(function* (integrationId) {
          return yield* db
            .select()
            .from(integrationToolListings)
            .where(eq(integrationToolListings.integrationId, integrationId))
            .pipe(Effect.orDie);
        }),

        claimDueListings: Effect.fn("IntegrationRepo.claimDueListings")(function* (input) {
          if (input.kinds.length === 0) return [];
          // Due and unleased by the database clock, like every other claim here.
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const due = yield* tx
                  .select({ id: integrationToolListings.id })
                  .from(integrationToolListings)
                  .innerJoin(
                    integrationConfigs,
                    eq(integrationConfigs.id, integrationToolListings.integrationId),
                  )
                  .leftJoin(
                    integrationConnections,
                    eq(integrationConnections.id, integrationToolListings.connectionId),
                  )
                  .where(
                    and(
                      eq(integrationConfigs.enabled, true),
                      // An account signed out lists nothing until it is signed in again,
                      // which lists it at once.
                      or(
                        isNull(integrationToolListings.connectionId),
                        eq(integrationConnections.status, "active"),
                      ),
                      lte(integrationToolListings.nextCheckAt, sql`clock_timestamp()`),
                      or(
                        isNull(integrationToolListings.checkLeaseUntil),
                        lte(integrationToolListings.checkLeaseUntil, sql`clock_timestamp()`),
                      ),
                      inArray(integrationConfigs.kind, [...input.kinds]),
                    ),
                  )
                  .orderBy(integrationToolListings.nextCheckAt)
                  .limit(input.limit)
                  .for("update", { of: integrationToolListings, skipLocked: true });
                if (due.length === 0) return [];
                return yield* tx
                  .update(integrationToolListings)
                  .set({ checkLeaseUntil: leaseFor(input.leaseMs / 1000) })
                  .where(
                    inArray(
                      integrationToolListings.id,
                      due.map((row) => row.id),
                    ),
                  )
                  .returning();
              }),
            )
            .pipe(Effect.orDie);
        }),

        startListing: Effect.fn("IntegrationRepo.startListing")(
          function* (integrationId, connectionId) {
            const token = uuidv7();
            // Selected from the integration (and the account), holding them while the
            // row goes in: one deleted meanwhile, say mid-sweep, starts no check.
            const upsert = { target: integrationToolListings.id, set: { checkToken: token } };
            const rows = connectionId
              ? yield* db
                  .insert(integrationToolListings)
                  .select((qb) =>
                    qb
                      .select({
                        id: integrationConnections.id,
                        integrationId: integrationConnections.integrationId,
                        connectionId: integrationConnections.id,
                        checkToken: sql<string>`${token}`.as("check_token"),
                      })
                      .from(integrationConnections)
                      .where(
                        and(
                          eq(integrationConnections.id, connectionId),
                          eq(integrationConnections.integrationId, integrationId),
                        ),
                      )
                      .for("key share"),
                  )
                  .onConflictDoUpdate(upsert)
                  .returning({ id: integrationToolListings.id })
                  .pipe(Effect.orDie)
              : yield* db
                  .insert(integrationToolListings)
                  .select((qb) =>
                    qb
                      .select({
                        id: integrationConfigs.id,
                        integrationId: integrationConfigs.id,
                        checkToken: sql<string>`${token}`.as("check_token"),
                      })
                      .from(integrationConfigs)
                      .where(eq(integrationConfigs.id, integrationId))
                      .for("key share"),
                  )
                  .onConflictDoUpdate(upsert)
                  .returning({ id: integrationToolListings.id })
                  .pipe(Effect.orDie);
            return rows.length ? token : null;
          },
        ),

        recordListing: Effect.fn("IntegrationRepo.recordListing")(
          function* (listingId, started, outcome, nextCheckAt) {
            const rows = yield* db
              .update(integrationToolListings)
              .set({
                ...("error" in outcome
                  ? { checkError: outcome.error }
                  : { tools: outcome.tools, server: outcome.server, checkError: null }),
                checkedAt: new Date(),
                nextCheckAt,
                checkLeaseUntil: null,
                checkToken: null,
              })
              .where(
                and(
                  eq(integrationToolListings.id, listingId),
                  eq(integrationToolListings.checkToken, started.token),
                  sql`exists (select 1 from ${integrationConfigs} where ${integrationConfigs.id} = ${integrationToolListings.integrationId} and ${integrationConfigs.revision} = ${started.revision})`,
                ),
              )
              .returning({ id: integrationToolListings.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        deleteToolListing: Effect.fn("IntegrationRepo.deleteToolListing")(
          function* (integrationId, connectionId) {
            yield* db
              .delete(integrationToolListings)
              .where(
                and(
                  eq(integrationToolListings.id, connectionId ?? integrationId),
                  eq(integrationToolListings.integrationId, integrationId),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),

        // Not a new revision: nobody's sign-in or listing depends on what the admin says of a tool.
        setToolSetting: Effect.fn("IntegrationRepo.setToolSetting")(
          function* (integrationId, tool, setting) {
            const rows = yield* db
              .update(integrationConfigs)
              .set({
                toolSettings: setting
                  ? sql`${integrationConfigs.toolSettings} || ${JSON.stringify({ [tool]: setting })}::jsonb`
                  : sql`${integrationConfigs.toolSettings} - ${tool}::text`,
                updatedAt: new Date(),
              })
              .where(eq(integrationConfigs.id, integrationId))
              .returning({ id: integrationConfigs.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        oauthClient: Effect.fn("IntegrationRepo.oauthClient")(
          function* (integrationId, issuer, clientId) {
            const rows = yield* db
              .select()
              .from(integrationOAuthClients)
              .where(
                and(
                  eq(integrationOAuthClients.integrationId, integrationId),
                  eq(integrationOAuthClients.issuer, issuer),
                  eq(integrationOAuthClients.clientId, clientId),
                ),
              )
              .pipe(Effect.orDie);
            return rows[0] ? yield* storedClient(rows[0]) : null;
          },
        ),

        reusableOAuthClient: Effect.fn("IntegrationRepo.reusableOAuthClient")(
          function* (integrationId, issuer, redirectUri) {
            const rows = yield* db
              .select()
              .from(integrationOAuthClients)
              .where(
                and(
                  eq(integrationOAuthClients.integrationId, integrationId),
                  eq(integrationOAuthClients.issuer, issuer),
                  eq(integrationOAuthClients.redirectUri, redirectUri),
                ),
              )
              .orderBy(desc(integrationOAuthClients.createdAt))
              .limit(1)
              .pipe(Effect.orDie);
            return rows[0] ? yield* storedClient(rows[0]) : null;
          },
        ),

        pinClientIssuer: Effect.fn("IntegrationRepo.pinClientIssuer")(
          function* (integrationId, revision, issuer) {
            const rows = yield* db
              .update(integrationConfigs)
              .set({
                oauthClientIssuer: sql`coalesce(${integrationConfigs.oauthClientIssuer}, ${issuer})`,
              })
              .where(
                and(
                  eq(integrationConfigs.id, integrationId),
                  eq(integrationConfigs.revision, revision),
                ),
              )
              .returning({ issuer: integrationConfigs.oauthClientIssuer })
              .pipe(Effect.orDie);
            return rows[0]?.issuer ?? null;
          },
        ),

        saveOAuthClient: Effect.fn("IntegrationRepo.saveOAuthClient")(
          function* (integrationId, issuer, client) {
            const secret = client.clientSecret ? yield* cipher.encrypt(client.clientSecret) : null;
            const values = {
              clientId: client.clientId,
              clientSecretCiphertext: secret,
              method: client.method,
              redirectUri: client.redirectUri,
            };
            yield* db
              .insert(integrationOAuthClients)
              .values({ integrationId, issuer, ...values })
              .onConflictDoNothing()
              .pipe(Effect.orDie);
          },
        ),

        // One statement, so parallel calls of an answer cannot both take the last use.
        reserveAllowance: Effect.fn("IntegrationRepo.reserveAllowance")(function* (input) {
          if (input.cap < 1) return false;
          const rows = yield* db
            .insert(integrationAllowanceUses)
            .values({
              messageId: input.messageId,
              connectionId: input.connectionId,
              allowanceId: input.allowanceId,
              uses: 1,
            })
            .onConflictDoUpdate({
              target: [
                integrationAllowanceUses.messageId,
                integrationAllowanceUses.connectionId,
                integrationAllowanceUses.allowanceId,
              ],
              set: { uses: sql`${integrationAllowanceUses.uses} + 1` },
              setWhere: sql`${integrationAllowanceUses.uses} < ${input.cap}`,
            })
            .returning({ uses: integrationAllowanceUses.uses })
            .pipe(Effect.orDie);
          return rows.length > 0;
        }),

        releaseAllowance: Effect.fn("IntegrationRepo.releaseAllowance")(function* (input) {
          yield* db
            .update(integrationAllowanceUses)
            .set({ uses: sql`greatest(${integrationAllowanceUses.uses} - 1, 0)` })
            .where(
              and(
                eq(integrationAllowanceUses.messageId, input.messageId),
                eq(integrationAllowanceUses.connectionId, input.connectionId),
                eq(integrationAllowanceUses.allowanceId, input.allowanceId),
              ),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
