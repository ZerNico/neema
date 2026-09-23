import { and, count, eq, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import {
  agentIntegrations,
  conversationAgents,
  conversationIntegrations,
  conversations,
  groupMembers,
  integrationConfigs,
  integrationConnections,
  integrationGroupGrants,
  integrationUserGrants,
  knowledgeCollections,
  knowledgeSources,
  schedules,
  user,
} from "~/db/schema/index.ts";
import type { ToolPermission } from "../consent.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";

export type IntegrationConfigRow = typeof integrationConfigs.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;

/** What a connection stores, encrypted as one JSON document. */
export type StoredCredentials =
  | { kind: "api_key"; apiKey: string }
  | {
      kind: "oauth";
      accessToken: string;
      refreshToken: string | null;
      /** Epoch milliseconds; null when the service gave no lifetime. */
      expiresAt: number | null;
    };

/**
 * Who may connect: everyone signed in when the audience is the instance,
 * admins always, otherwise a user or group grant. SQL, so the settings list,
 * connect and every attempt apply the same rule.
 */
export const integrationUsableBy = (userId: string): SQL => sql`(
  ${integrationConfigs.audience} = 'instance'
  or exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')
  or exists(select 1 from ${integrationUserGrants} where ${integrationUserGrants.integrationId} = ${integrationConfigs.id} and ${integrationUserGrants.userId} = ${userId})
  or exists(select 1 from ${integrationGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${integrationGroupGrants.groupId}
    where ${integrationGroupGrants.integrationId} = ${integrationConfigs.id} and ${groupMembers.userId} = ${userId})
)`;

export interface SaveConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly config: Record<string, string>;
  readonly fingerprint: string;
  readonly oauthClientId: string | null;
  /** Absent keeps the stored secret; empty string clears it. */
  readonly oauthClientSecret?: string | undefined;
  readonly allowApiKeys: boolean;
}

export class IntegrationRepo extends Context.Service<
  IntegrationRepo,
  {
    listConfigs(): Effect.Effect<ReadonlyArray<IntegrationConfigRow & { connectionCount: number }>>;
    getConfig(id: string): Effect.Effect<IntegrationConfigRow | null>;
    /** The OAuth client secret, decrypted, for the token endpoint only. */
    clientSecret(row: IntegrationConfigRow): Effect.Effect<string | null>;
    /**
     * Saves instance setup. A changed fingerprint (another base URL) marks
     * every connection for reconnecting: its credentials name another server.
     */
    saveConfig(input: SaveConfig): Effect.Effect<IntegrationConfigRow>;
    /** Integrations this person may use, enabled or not, with their connection if any. */
    listForUser(userId: string): Effect.Effect<
      ReadonlyArray<{
        config: IntegrationConfigRow;
        usable: boolean;
        connection: IntegrationConnectionRow | null;
      }>
    >;
    isUsable(userId: string, integrationId: string): Effect.Effect<boolean>;
    getConnection(
      userId: string,
      integrationId: string,
    ): Effect.Effect<IntegrationConnectionRow | null>;
    getConnectionById(id: string): Effect.Effect<IntegrationConnectionRow | null>;
    saveConnection(input: {
      userId: string;
      integrationId: string;
      authKind: "oauth" | "api_key";
      credentials: StoredCredentials;
      accountLabel: string;
      fingerprint: string;
    }): Effect.Effect<IntegrationConnectionRow>;
    updatePreferences(
      userId: string,
      integrationId: string,
      input: { offerByDefault?: boolean; toolPermissions?: Record<string, ToolPermission> },
    ): Effect.Effect<IntegrationConnectionRow | null>;
    removeConnection(userId: string, integrationId: string): Effect.Effect<void>;
    markNeedsReauth(connectionId: string): Effect.Effect<void>;
    decrypt(row: IntegrationConnectionRow): Effect.Effect<StoredCredentials>;
    encrypt(credentials: StoredCredentials): Effect.Effect<string>;
    dependents(
      userId: string,
      integrationId: string,
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
      integrationId: string,
      input: { enabled?: boolean | null; allowTool?: string },
    ): Effect.Effect<boolean>;
    /** The integrations a chat's installed agent attached, or null for plain chat. */
    agentIntegrationIds(conversationId: string): Effect.Effect<ReadonlyArray<string> | null>;
  }
>()("chat/integrations/IntegrationRepo") {
  static readonly layer = Layer.effect(
    IntegrationRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const decrypt = (row: IntegrationConnectionRow) =>
        cipher
          .decrypt(row.credentialsCiphertext)
          .pipe(Effect.map((secret) => JSON.parse(Redacted.value(secret)) as StoredCredentials));

      return IntegrationRepo.of({
        listConfigs: Effect.fn("IntegrationRepo.listConfigs")(function* () {
          const rows = yield* db
            .select({
              config: integrationConfigs,
              connectionCount: sql<number>`(select count(*)::int from ${integrationConnections} where ${integrationConnections.integrationId} = ${integrationConfigs.id})`,
            })
            .from(integrationConfigs)
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
          const now = new Date();
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const rows = yield* tx
                  .insert(integrationConfigs)
                  .values({
                    id: input.id,
                    enabled: input.enabled,
                    config: input.config,
                    oauthClientId: input.oauthClientId,
                    oauthClientSecretCiphertext: secret ?? null,
                    allowApiKeys: input.allowApiKeys,
                    updatedAt: now,
                  })
                  .onConflictDoUpdate({
                    target: integrationConfigs.id,
                    set: {
                      enabled: input.enabled,
                      config: input.config,
                      oauthClientId: input.oauthClientId,
                      ...(secret === undefined ? {} : { oauthClientSecretCiphertext: secret }),
                      allowApiKeys: input.allowApiKeys,
                      updatedAt: now,
                    },
                  })
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
                return rows[0]!;
              }),
            )
            .pipe(Effect.orDie);
        }),

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
          return rows.map((row) => ({
            config: row.config,
            usable: Boolean(row.usable),
            connection: row.connection,
          }));
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

        getConnection: Effect.fn("IntegrationRepo.getConnection")(
          function* (userId, integrationId) {
            const rows = yield* db
              .select()
              .from(integrationConnections)
              .where(
                and(
                  eq(integrationConnections.userId, userId),
                  eq(integrationConnections.integrationId, integrationId),
                ),
              )
              .pipe(Effect.orDie);
            return rows[0] ?? null;
          },
        ),

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
          const rows = yield* db
            .insert(integrationConnections)
            .values({
              id: uuidv7(),
              userId: input.userId,
              integrationId: input.integrationId,
              authKind: input.authKind,
              credentialsCiphertext,
              accountLabel: input.accountLabel,
              configFingerprint: input.fingerprint,
            })
            .onConflictDoUpdate({
              target: [integrationConnections.userId, integrationConnections.integrationId],
              // Reconnecting keeps the person's preferences; only the
              // credentials and what they point at are replaced.
              set: {
                authKind: input.authKind,
                credentialsCiphertext,
                accountLabel: input.accountLabel,
                configFingerprint: input.fingerprint,
                status: "active",
                updatedAt: now,
              },
            })
            .returning()
            .pipe(Effect.orDie);
          // Sources that paused while the owner was disconnected resume within a
          // tick instead of waiting out their hourly slot.
          yield* db
            .update(knowledgeSources)
            .set({ nextSyncAt: sql`now()` })
            .where(
              and(
                eq(knowledgeSources.integrationId, input.integrationId),
                sql`${knowledgeSources.collectionId} in (select ${knowledgeCollections.id} from ${knowledgeCollections} where ${knowledgeCollections.userId} = ${input.userId})`,
              ),
            )
            .pipe(Effect.orDie);
          return rows[0]!;
        }),

        updatePreferences: Effect.fn("IntegrationRepo.updatePreferences")(
          function* (userId, integrationId, input) {
            const rows = yield* db
              .update(integrationConnections)
              .set({
                ...(input.offerByDefault === undefined
                  ? {}
                  : { offerByDefault: input.offerByDefault }),
                // Merged in SQL, so two quick changes to different tools both stay.
                ...(input.toolPermissions === undefined
                  ? {}
                  : {
                      toolPermissions: sql`${integrationConnections.toolPermissions} || ${JSON.stringify(input.toolPermissions)}::jsonb`,
                    }),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(integrationConnections.userId, userId),
                  eq(integrationConnections.integrationId, integrationId),
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            return rows[0] ?? null;
          },
        ),

        removeConnection: Effect.fn("IntegrationRepo.removeConnection")(
          function* (userId, integrationId) {
            yield* db
              .delete(integrationConnections)
              .where(
                and(
                  eq(integrationConnections.userId, userId),
                  eq(integrationConnections.integrationId, integrationId),
                ),
              )
              .pipe(Effect.orDie);
          },
        ),

        markNeedsReauth: Effect.fn("IntegrationRepo.markNeedsReauth")(function* (connectionId) {
          yield* db
            .update(integrationConnections)
            .set({ status: "needs_reauth", updatedAt: new Date() })
            .where(eq(integrationConnections.id, connectionId))
            .pipe(Effect.orDie);
        }),

        decrypt,
        encrypt: (credentials) => cipher.encrypt(JSON.stringify(credentials)),

        dependents: Effect.fn("IntegrationRepo.dependents")(function* (userId, integrationId) {
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
                eq(knowledgeSources.integrationId, integrationId),
              ),
            )
            .pipe(Effect.orDie);
          const [scheduled] = yield* db
            .select({ total: count() })
            .from(schedules)
            .where(
              and(
                eq(schedules.userId, userId),
                sql`${schedules.integrationGrants} @> ${JSON.stringify([{ integrationId }])}::jsonb`,
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
          function* (userId, conversationId, integrationId, input) {
            const owned = yield* db
              .select({ id: conversations.id })
              .from(conversations)
              .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
              .pipe(Effect.orDie);
            if (owned.length === 0) return false;
            const set = {
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              updatedAt: new Date(),
            };
            const allowed = input.allowTool ? [input.allowTool] : [];
            yield* db
              .insert(conversationIntegrations)
              .values({ conversationId, integrationId, ...set, allowedTools: allowed })
              .onConflictDoUpdate({
                target: [
                  conversationIntegrations.conversationId,
                  conversationIntegrations.integrationId,
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
      });
    }),
  );
}
