import { and, count, eq, sql, type SQL } from "drizzle-orm";
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
  integrationUserGrants,
  knowledgeCollections,
  knowledgeSources,
  schedules,
  user,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import type { ToolPermission } from "../consent.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";

export type IntegrationConfigRow = typeof integrationConfigs.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;

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
  }),
]);
export type StoredCredentials = typeof StoredCredentials.Type;
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCredentials));

/**
 * Who may connect: everyone signed in when the audience is the instance,
 * admins always, otherwise a user or group grant. SQL, so the settings list,
 * connect and every attempt apply the same rule.
 */
/** A type's own kind for its first integration, then numbered: `jira`, `jira-2`. */
const freeId = (kind: string, taken: ReadonlyArray<string>) => {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  let n = 2;
  while (used.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
};

export const integrationUsableBy = (userId: string): SQL => sql`(
  ${integrationConfigs.audience} = 'instance'
  or exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')
  or exists(select 1 from ${integrationUserGrants} where ${integrationUserGrants.integrationId} = ${integrationConfigs.id} and ${integrationUserGrants.userId} = ${userId})
  or exists(select 1 from ${integrationGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${integrationGroupGrants.groupId}
    where ${integrationGroupGrants.integrationId} = ${integrationConfigs.id} and ${groupMembers.userId} = ${userId})
)`;

export interface SaveConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, string>;
  readonly fingerprint: string;
  readonly oauthClientId: string | null;
  /** Absent keeps the stored secret; empty string clears it. */
  readonly oauthClientSecret?: string | undefined;
  readonly allowApiKeys: boolean;
}

export interface AllowanceUse {
  messageId: string;
  integrationId: string;
  allowanceId: string;
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
    saveConfig(input: SaveConfig): Effect.Effect<IntegrationConfigRow | null>;
    /** A new integration, off and unconfigured; false when the id or name is taken. */
    /**
     * Adds an integration under the first free id of its type (`jira`, then
     * `jira-2`), or returns null when the name is already in use.
     */
    createConfig(input: { kind: string; name: string }): Effect.Effect<string | null>;
    /**
     * Removes an integration with everything that only meant something with it
     * (connections, grants, chat and agent settings, through their foreign keys)
     * and takes it out of schedules. Refused while knowledge sources mirror it.
     */
    deleteConfig(
      id: string,
    ): Effect.Effect<{ deleted: true } | { deleted: false; sources: number }>;
    /** Whether another integration already uses this name, ignoring case. */
    nameTaken(name: string, exceptId: string | null): Effect.Effect<boolean>;
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
      input: {
        offerByDefault?: boolean;
        toolPermissions?: Record<string, ToolPermission>;
        /** Null lifts the limit. */
        scope?: string[] | null;
      },
    ): Effect.Effect<IntegrationConnectionRow | null>;
    removeConnection(userId: string, integrationId: string): Effect.Effect<void>;
    markNeedsReauth(connectionId: string): Effect.Effect<void>;
    /** Null when the stored document is not one this version reads; the person reconnects. */
    decrypt(row: IntegrationConnectionRow): Effect.Effect<StoredCredentials | null>;
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

      const decrypt = (row: IntegrationConnectionRow) =>
        cipher
          .decrypt(row.credentialsCiphertext)
          .pipe(Effect.map((secret) => Option.getOrNull(decodeStored(Redacted.value(secret)))));

      const nameTaken = Effect.fn("IntegrationRepo.nameTaken")(function* (
        name: string,
        exceptId: string | null,
      ) {
        const rows = yield* db
          .select({ id: integrationConfigs.id })
          .from(integrationConfigs)
          .where(
            and(
              sql`lower(${integrationConfigs.name}) = lower(${name})`,
              exceptId ? sql`${integrationConfigs.id} <> ${exceptId}` : undefined,
            ),
          )
          .pipe(Effect.orDie);
        return rows.length > 0;
      });

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
                  .update(integrationConfigs)
                  .set({
                    name: input.name,
                    enabled: input.enabled,
                    config: input.config,
                    oauthClientId: input.oauthClientId,
                    ...(secret === undefined ? {} : { oauthClientSecretCiphertext: secret }),
                    allowApiKeys: input.allowApiKeys,
                    updatedAt: now,
                  })
                  .where(eq(integrationConfigs.id, input.id))
                  .returning();
                if (!rows[0]) return null;
                yield* tx
                  .update(integrationConnections)
                  .set({ status: "needs_reauth", updatedAt: now })
                  .where(
                    and(
                      eq(integrationConnections.integrationId, input.id),
                      sql`${integrationConnections.configFingerprint} <> ${input.fingerprint}`,
                    ),
                  );
                return rows[0];
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
              .values({ id, kind: input.kind, name: input.name })
              .onConflictDoNothing()
              .returning({ id: integrationConfigs.id })
              .pipe(Effect.orDie);
            if (rows.length) return id;
            if (yield* nameTaken(input.name, null)) return null;
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
                ...(input.scope === undefined ? {} : { scope: input.scope }),
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
              .where(ownedConversationById(conversationId, userId))
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

        // One statement, so parallel calls of an answer cannot both take the last use.
        reserveAllowance: Effect.fn("IntegrationRepo.reserveAllowance")(function* (input) {
          if (input.cap < 1) return false;
          const rows = yield* db
            .insert(integrationAllowanceUses)
            .values({
              messageId: input.messageId,
              integrationId: input.integrationId,
              allowanceId: input.allowanceId,
              uses: 1,
            })
            .onConflictDoUpdate({
              target: [
                integrationAllowanceUses.messageId,
                integrationAllowanceUses.integrationId,
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
                eq(integrationAllowanceUses.integrationId, input.integrationId),
                eq(integrationAllowanceUses.allowanceId, input.allowanceId),
              ),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
