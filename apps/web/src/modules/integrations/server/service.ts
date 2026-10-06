import { and, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { integrationConnections, verification } from "~/db/schema/index.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegration, INTEGRATIONS } from "../catalog.ts";
import {
  IntegrationAuthFailed,
  IntegrationNotAvailable,
  IntegrationRejected,
  IntegrationRequestFailed,
} from "../errors.ts";
import type { ToolPermission, UnattendedGrant } from "../consent.ts";
import type { IntegrationGrant } from "../grant.ts";
import type { AdminIntegration, ScopeOption, UserIntegration } from "../schema.ts";
import { readFields } from "../fields.ts";
import type { Credential, IntegrationAdapter, IntegrationSession } from "./adapter.ts";
import { findAdapter } from "./adapters.ts";
import {
  authorizeUrl,
  callbackPath,
  OAUTH_STATE_TTL_MS,
  randomToken,
  requestTokens,
  sha256,
} from "./oauth.ts";
import {
  IntegrationRepo,
  type IntegrationConfigRow,
  type IntegrationConnectionRow,
  type SaveConfig,
  type StoredCredentials,
} from "./repo.ts";

/** Refresh this long before the service would expire the token. */
const REFRESH_MARGIN_MS = 60_000;
const stateIdentifier = (state: string) => `integration-oauth:${sha256(state)}`;

interface OAuthStateValue {
  userId: string;
  integrationId: string;
  verifier: string;
  redirectUri: string;
  /** A path on this app to land on afterwards; validated when it was given. */
  returnTo?: string;
}

export interface ConnectedSession extends IntegrationSession {
  readonly connectionId: string;
  readonly adapter: IntegrationAdapter;
}

/** One integration as a chat sees it: whether it is on here, and how much it asks. */
export interface ChatIntegration {
  integrationId: string;
  accountLabel: string;
  enabled: boolean;
  /** What `enabled` would be without this chat's own choice. */
  defaultEnabled: boolean;
}

export interface ResolvedOffer {
  integrationId: string;
  session: ConnectedSession;
  /** The connection's limit as the generation starts, to tell the model; calls read it fresh. */
  scope: ReadonlyArray<string> | null;
  unattended: UnattendedGrant;
  /** As the generation starts; a blocked tool is not offered at all. */
  permissions: Record<string, ToolPermission>;
}

/** What decides one call, read fresh each time so a change applies mid-answer. */
export interface CallPermissions {
  permissions: Record<string, ToolPermission>;
  allowedInChat: ReadonlyArray<string>;
}

type RefreshResult =
  | { kind: "credential"; credential: Credential }
  | { kind: "revoked" }
  | { kind: "failed"; message: string };

const oauthReady = (row: IntegrationConfigRow | null) =>
  Boolean(row?.oauthClientId && row.oauthClientSecretCiphertext);

const toAdmin = (
  id: string,
  row: (IntegrationConfigRow & { connectionCount: number }) | null,
): AdminIntegration => ({
  id,
  saved: row !== null,
  enabled: row?.enabled ?? false,
  config: row?.config ?? {},
  oauthClientId: row?.oauthClientId ?? null,
  oauthSecretConfigured: Boolean(row?.oauthClientSecretCiphertext),
  allowApiKeys: row?.allowApiKeys ?? true,
  audience: row?.audience ?? "instance",
  connectionCount: row?.connectionCount ?? 0,
});

/** A session for a credential not stored yet, to verify it before saving. */
const probe = (config: Record<string, string>, credential: Credential): IntegrationSession => ({
  config,
  credential: Effect.succeed(credential),
  scope: Effect.succeed(null),
});

/** At most this many items in one connection's limit. */
const MAX_SCOPE_ITEMS = 200;

const verified = (
  adapter: IntegrationAdapter,
  config: Record<string, string>,
  credential: Credential,
) =>
  adapter.verify(probe(config, credential)).pipe(
    Effect.catchTags({
      IntegrationAuthFailed: () =>
        Effect.fail(
          new IntegrationRejected({ reason: "The service did not accept that credential." }),
        ),
      IntegrationRequestFailed: (error) =>
        Effect.fail(new IntegrationRejected({ reason: error.message })),
    }),
  );

export class IntegrationService extends Context.Service<
  IntegrationService,
  {
    adminList(): Effect.Effect<ReadonlyArray<AdminIntegration>>;
    saveConfig(
      input: Omit<SaveConfig, "fingerprint">,
    ): Effect.Effect<AdminIntegration, IntegrationRejected>;
    listForUser(userId: string): Effect.Effect<ReadonlyArray<UserIntegration>>;
    connectApiKey(
      userId: string,
      integrationId: string,
      /** The manifest's API key fields as typed; undeclared keys are dropped. */
      values: Readonly<Record<string, string>>,
    ): Effect.Effect<void, IntegrationNotAvailable | IntegrationRejected>;
    beginOAuth(
      userId: string,
      integrationId: string,
      origin: string,
      returnTo?: string,
    ): Effect.Effect<{ url: string; state: string }, IntegrationNotAvailable | IntegrationRejected>;
    completeOAuth(
      userId: string,
      integrationId: string,
      input: { code: string; state: string; cookieState: string | null },
    ): Effect.Effect<{ returnTo: string | null }, IntegrationNotAvailable | IntegrationRejected>;
    updatePreferences(
      userId: string,
      integrationId: string,
      input: Parameters<IntegrationRepo["Service"]["updatePreferences"]>[2],
    ): Effect.Effect<void, IntegrationNotAvailable | IntegrationRejected>;
    /** What a connection can be limited to, from the service as this person sees it. */
    scopeOptions(
      userId: string,
      integrationId: string,
    ): Effect.Effect<ReadonlyArray<ScopeOption>, IntegrationNotAvailable | IntegrationRejected>;
    disconnect(userId: string, integrationId: string): Effect.Effect<void>;
    /**
     * A working session as this person, or `IntegrationNotAvailable` when the
     * integration is off, unshared, unconnected or waiting for reconnect.
     */
    session(
      userId: string,
      integrationId: string,
    ): Effect.Effect<ConnectedSession, IntegrationNotAvailable>;
    /** Marks a connection whose credentials the service refused. */
    reportAuthFailure(connection: { userId: string; connectionId: string }): Effect.Effect<void>;
    /**
     * Connected, usable integrations and whether this chat offers them: the
     * chat's own choice, else the agent's attachments, else the connection's
     * "turn on in new chats". A null conversation is a chat not created yet.
     */
    chatIntegrations(
      userId: string,
      conversationId: string | null,
    ): Effect.Effect<ReadonlyArray<ChatIntegration>>;
    /**
     * What one attempt is offered, with working sessions. A schedule fire
     * passes its grants, which replace the chat's choices entirely.
     */
    resolveOffer(input: {
      userId: string;
      conversationId: string;
      grants: ReadonlyArray<IntegrationGrant> | null;
    }): Effect.Effect<ReadonlyArray<ResolvedOffer>>;
    permissionsFor(
      userId: string,
      conversationId: string,
      integrationId: string,
    ): Effect.Effect<CallPermissions>;
    setConversationIntegration(
      userId: string,
      conversationId: string,
      integrationId: string,
      input: { enabled?: boolean | null; allowTool?: string },
    ): Effect.Effect<void, IntegrationNotAvailable>;
    reserveAllowance: IntegrationRepo["Service"]["reserveAllowance"];
    releaseAllowance: IntegrationRepo["Service"]["releaseAllowance"];
  }
>()("chat/integrations/IntegrationService") {
  static readonly layer = Layer.effect(
    IntegrationService,
    Effect.gen(function* () {
      const db = yield* Db;
      const repo = yield* IntegrationRepo;
      const bus = yield* SyncBus;

      const changed = (userId: string) =>
        bus
          .publish(userId, { type: "integrations.changed" })
          .pipe(Effect.catchCause(() => Effect.void));

      /** The adapter plus normalized config, or why it cannot be used right now. */
      const available = Effect.fn(function* (userId: string, integrationId: string) {
        const adapter = findAdapter(integrationId);
        const row = yield* repo.getConfig(integrationId);
        if (!adapter || !row?.enabled || !(yield* repo.isUsable(userId, integrationId)))
          return yield* new IntegrationNotAvailable({ integrationId });
        const normalized = adapter.normalizeConfig(row.config);
        if ("error" in normalized) return yield* new IntegrationNotAvailable({ integrationId });
        return { adapter, row, ...normalized };
      });

      const refresh = (
        connectionId: string,
        row: IntegrationConfigRow,
        adapter: IntegrationAdapter,
      ) =>
        Effect.gen(function* () {
          const oauth = adapter.oauth;
          const clientSecret = yield* repo.clientSecret(row);
          // The lock makes concurrent callers (a chat and a sync, say) take
          // turns: the first rotates the refresh token, the rest find a fresh
          // access token instead of spending a refresh token already used.
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [locked] = yield* tx
                  .select()
                  .from(integrationConnections)
                  .where(eq(integrationConnections.id, connectionId))
                  .for("update");
                if (!locked) return { kind: "revoked" } satisfies RefreshResult;
                const stored = yield* repo.decrypt(locked);
                if (stored?.kind === "api_key")
                  return {
                    kind: "credential",
                    credential: { kind: "api_key", values: stored.values },
                  } satisfies RefreshResult;
                if (
                  stored &&
                  (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
                )
                  return {
                    kind: "credential",
                    credential: { kind: "oauth", accessToken: stored.accessToken },
                  } satisfies RefreshResult;
                if (!stored?.refreshToken || !oauth || !row.oauthClientId) {
                  yield* tx
                    .update(integrationConnections)
                    .set({ status: "needs_reauth", updatedAt: new Date() })
                    .where(eq(integrationConnections.id, connectionId));
                  return { kind: "revoked" } satisfies RefreshResult;
                }
                const outcome = yield* requestTokens({
                  endpoint: oauth.tokenUrl(row.config),
                  clientId: row.oauthClientId,
                  clientSecret,
                  params: { grant_type: "refresh_token", refresh_token: stored.refreshToken },
                }).pipe(
                  Effect.catchTag("IntegrationRequestFailed", (error) =>
                    Effect.succeed({ ok: false as const, revoked: false, message: error.message }),
                  ),
                );
                if (!outcome.ok) {
                  if (!outcome.revoked)
                    return {
                      kind: "failed",
                      message: "Could not refresh the sign-in.",
                    } satisfies RefreshResult;
                  yield* tx
                    .update(integrationConnections)
                    .set({ status: "needs_reauth", updatedAt: new Date() })
                    .where(eq(integrationConnections.id, connectionId));
                  return { kind: "revoked" } satisfies RefreshResult;
                }
                const next: StoredCredentials = {
                  kind: "oauth",
                  accessToken: outcome.tokens.accessToken,
                  // Services that do not rotate send no new refresh token.
                  refreshToken: outcome.tokens.refreshToken ?? stored.refreshToken,
                  expiresAt: outcome.tokens.expiresAt,
                };
                yield* tx
                  .update(integrationConnections)
                  .set({ credentialsCiphertext: yield* repo.encrypt(next), updatedAt: new Date() })
                  .where(eq(integrationConnections.id, connectionId));
                return {
                  kind: "credential",
                  credential: { kind: "oauth", accessToken: next.accessToken },
                } satisfies RefreshResult;
              }),
            )
            .pipe(Effect.orDie);
          return result as RefreshResult;
        });

      const credentialFor = (
        connection: IntegrationConnectionRow,
        row: IntegrationConfigRow,
        adapter: IntegrationAdapter,
      ): Effect.Effect<Credential, IntegrationAuthFailed | IntegrationRequestFailed> =>
        Effect.gen(function* () {
          const current = yield* repo.getConnectionById(connection.id);
          if (!current || current.status !== "active")
            return yield* new IntegrationAuthFailed({ integrationId: adapter.id });
          const enabled = yield* available(connection.userId, adapter.id).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (!enabled || current.configFingerprint !== enabled.fingerprint)
            return yield* new IntegrationRequestFailed({
              status: null,
              message: "This integration is no longer available.",
            });
          const stored = yield* repo.decrypt(current);
          if (stored?.kind === "api_key") return { kind: "api_key", values: stored.values };
          if (
            stored &&
            (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
          )
            return { kind: "oauth", accessToken: stored.accessToken };
          // Expired or unreadable: refreshing decides under the row lock.
          const result = yield* refresh(connection.id, row, adapter);
          if (result.kind === "credential") return result.credential;
          if (result.kind === "revoked") {
            yield* changed(connection.userId);
            return yield* new IntegrationAuthFailed({ integrationId: adapter.id });
          }
          return yield* new IntegrationRequestFailed({ status: null, message: result.message });
        });

      const sessionFor = Effect.fn("IntegrationService.session")(function* (
        userId: string,
        integrationId: string,
      ) {
        const { adapter, row, config, fingerprint } = yield* available(userId, integrationId);
        const connection = yield* repo.getConnection(userId, integrationId);
        if (
          !connection ||
          connection.status !== "active" ||
          connection.configFingerprint !== fingerprint
        )
          return yield* new IntegrationNotAvailable({ integrationId });
        const session: ConnectedSession = {
          connectionId: connection.id,
          adapter,
          config,
          credential: credentialFor(connection, row, adapter),
          // Read fresh, so narrowing it applies to an answer already running.
          // A connection gone meanwhile reaches nothing.
          scope: findIntegration(integrationId)?.scope
            ? repo
                .getConnectionById(connection.id)
                .pipe(Effect.map((current) => (current ? current.scope : [])))
            : Effect.succeed(null),
        };
        return session;
      });

      /** Connections that work right now, keyed by integration. */
      const usableConnections = Effect.fn(function* (userId: string) {
        const rows = yield* repo.listForUser(userId);
        const usable = new Map<string, IntegrationConnectionRow>();
        for (const row of rows) {
          const adapter = findAdapter(row.config.id);
          if (!adapter || !row.config.enabled || !row.usable || !row.connection) continue;
          const normalized = adapter.normalizeConfig(row.config.config);
          if ("error" in normalized) continue;
          if (row.connection.status !== "active") continue;
          if (row.connection.configFingerprint !== normalized.fingerprint) continue;
          usable.set(row.config.id, row.connection);
        }
        return usable;
      });

      const chatIntegrations = Effect.fn("IntegrationService.chatIntegrations")(function* (
        userId: string,
        conversationId: string | null,
      ) {
        const usable = yield* usableConnections(userId);
        const settings = conversationId ? yield* repo.conversationSettings(conversationId) : [];
        const attached = conversationId ? yield* repo.agentIntegrationIds(conversationId) : null;
        const result: ChatIntegration[] = [];
        for (const manifest of INTEGRATIONS) {
          const connection = usable.get(manifest.id);
          if (!connection) continue;
          const own = settings.find((entry) => entry.integrationId === manifest.id);
          const defaultEnabled = attached
            ? attached.includes(manifest.id)
            : connection.offerByDefault;
          result.push({
            integrationId: manifest.id,
            accountLabel: connection.accountLabel,
            enabled: own?.enabled ?? defaultEnabled,
            defaultEnabled,
          });
        }
        return result;
      });

      return IntegrationService.of({
        chatIntegrations,
        reserveAllowance: repo.reserveAllowance,
        releaseAllowance: repo.releaseAllowance,

        resolveOffer: Effect.fn("IntegrationService.resolveOffer")(function* (input) {
          const chosen: Array<{ integrationId: string; unattended: UnattendedGrant }> = input.grants
            ? input.grants.map((grant) => ({
                integrationId: grant.integrationId,
                unattended: {
                  access: grant.access,
                  allowances: Object.fromEntries(
                    Object.entries(grant.allowances ?? {}).map(([id, entry]) => [
                      id,
                      entry.targets,
                    ]),
                  ),
                },
              }))
            : (yield* chatIntegrations(input.userId, input.conversationId))
                .filter((entry) => entry.enabled)
                .map((entry) => ({ integrationId: entry.integrationId, unattended: null }));
          const offers: ResolvedOffer[] = [];
          for (const entry of chosen) {
            // A connection gone since the turn was accepted drops out of the
            // offer, like a disabled custom tool, rather than failing it.
            const session = yield* sessionFor(input.userId, entry.integrationId).pipe(
              Effect.option,
            );
            if (session._tag === "Some") {
              const connection = yield* repo.getConnection(input.userId, entry.integrationId);
              offers.push({
                integrationId: entry.integrationId,
                session: session.value,
                scope: findIntegration(entry.integrationId)?.scope
                  ? (connection?.scope ?? null)
                  : null,
                unattended: entry.unattended,
                permissions: connection?.toolPermissions ?? {},
              });
            }
          }
          return offers;
        }),

        permissionsFor: Effect.fn("IntegrationService.permissionsFor")(
          function* (userId, conversationId, integrationId) {
            const settings = yield* repo.conversationSettings(conversationId);
            const own = settings.find((entry) => entry.integrationId === integrationId);
            const connection = yield* repo.getConnection(userId, integrationId);
            return {
              permissions: connection?.toolPermissions ?? {},
              allowedInChat: own?.allowedTools ?? [],
            };
          },
        ),

        setConversationIntegration: Effect.fn("IntegrationService.setConversationIntegration")(
          function* (userId, conversationId, integrationId, input) {
            if (!findIntegration(integrationId))
              return yield* new IntegrationNotAvailable({ integrationId });
            const saved = yield* repo.setConversationSetting(
              userId,
              conversationId,
              integrationId,
              input,
            );
            if (!saved) return yield* new IntegrationNotAvailable({ integrationId });
            yield* changed(userId);
          },
        ),

        adminList: Effect.fn("IntegrationService.adminList")(function* () {
          const rows = yield* repo.listConfigs();
          return INTEGRATIONS.map((manifest) =>
            toAdmin(manifest.id, rows.find((row) => row.id === manifest.id) ?? null),
          );
        }),

        saveConfig: Effect.fn("IntegrationService.saveConfig")(function* (input) {
          const manifest = findIntegration(input.id);
          const adapter = findAdapter(input.id);
          if (!manifest || !adapter)
            return yield* new IntegrationRejected({ reason: "Unknown integration." });
          const known = new Set(manifest.adminFields.map((field) => field.key));
          const config = Object.fromEntries(
            Object.entries(input.config).filter(([key]) => known.has(key)),
          );
          const normalized = adapter.normalizeConfig(config);
          if ("error" in normalized)
            return yield* new IntegrationRejected({ reason: normalized.error });
          const stored = yield* repo.getConfig(input.id);
          const clientId = input.oauthClientId?.trim() || null;
          const willHaveSecret =
            input.oauthClientSecret === undefined
              ? Boolean(stored?.oauthClientSecretCiphertext)
              : input.oauthClientSecret !== "";
          if (clientId && !willHaveSecret && manifest.oauth)
            return yield* new IntegrationRejected({ reason: "Enter the OAuth client secret too." });
          const oauthOn = Boolean(manifest.oauth && clientId && willHaveSecret);
          if (input.enabled && !oauthOn && !(manifest.apiKey && input.allowApiKeys))
            return yield* new IntegrationRejected({
              reason: "Set up OAuth or allow personal API keys before turning this on.",
            });
          const row = yield* repo.saveConfig({
            ...input,
            oauthClientId: clientId,
            config: normalized.config,
            fingerprint: normalized.fingerprint,
          });
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
          const counted = (yield* repo.listConfigs()).find((entry) => entry.id === row.id) ?? null;
          return toAdmin(row.id, counted);
        }),

        listForUser: Effect.fn("IntegrationService.listForUser")(function* (userId) {
          const rows = yield* repo.listForUser(userId);
          const result: UserIntegration[] = [];
          for (const manifest of INTEGRATIONS) {
            const entry = rows.find((row) => row.config.id === manifest.id);
            const adapter = findAdapter(manifest.id);
            if (!entry || !adapter) continue;
            const normalized = adapter.normalizeConfig(entry.config.config);
            const configured = !("error" in normalized);
            const methods = {
              oauth: Boolean(manifest.oauth && adapter.oauth && oauthReady(entry.config)),
              apiKey: Boolean(manifest.apiKey && entry.config.allowApiKeys),
            };
            const open =
              entry.config.enabled &&
              entry.usable &&
              configured &&
              (methods.oauth || methods.apiKey);
            // A connection outlives its integration being switched off, so it
            // still shows (and can be removed) even when nothing new may start.
            if (!open && !entry.connection) continue;
            const connection = entry.connection;
            const stale =
              connection !== null &&
              configured &&
              connection.configFingerprint !== normalized.fingerprint;
            result.push({
              id: manifest.id,
              available: open,
              methods,
              apiKeyHelpUrl: configured
                ? (manifest.apiKey?.helpUrl(normalized.config) ?? null)
                : null,
              connection: connection
                ? {
                    id: connection.id,
                    authKind: connection.authKind,
                    accountLabel: connection.accountLabel,
                    status: stale ? "needs_reauth" : connection.status,
                    offerByDefault: connection.offerByDefault,
                    toolPermissions: connection.toolPermissions,
                    scope: connection.scope,
                    createdAt: connection.createdAt.toISOString(),
                  }
                : null,
              dependents: connection
                ? yield* repo.dependents(userId, manifest.id)
                : { sources: 0, schedules: 0 },
            });
          }
          return result;
        }),

        connectApiKey: Effect.fn("IntegrationService.connectApiKey")(
          function* (userId, integrationId, input) {
            const { adapter, row, config, fingerprint } = yield* available(userId, integrationId);
            const form = findIntegration(integrationId)?.apiKey;
            if (!row.allowApiKeys || !form)
              return yield* new IntegrationRejected({
                reason: "API keys are turned off for this integration.",
              });
            const read = readFields(form.fields, input);
            if ("error" in read) return yield* new IntegrationRejected({ reason: read.error });
            const { values } = read;
            const { accountLabel } = yield* verified(adapter, config, { kind: "api_key", values });
            yield* repo.saveConnection({
              userId,
              integrationId,
              authKind: "api_key",
              credentials: { kind: "api_key", values },
              accountLabel,
              fingerprint,
            });
            yield* changed(userId);
          },
        ),

        beginOAuth: Effect.fn("IntegrationService.beginOAuth")(
          function* (userId, integrationId, origin, returnTo) {
            const { adapter, row, config } = yield* available(userId, integrationId);
            if (!adapter.oauth || !row.oauthClientId || !row.oauthClientSecretCiphertext)
              return yield* new IntegrationRejected({
                reason: "OAuth is not set up for this integration.",
              });
            const state = randomToken();
            const verifier = randomToken();
            const redirectUri = `${origin}${callbackPath(integrationId)}`;
            const value: OAuthStateValue = {
              userId,
              integrationId,
              verifier,
              redirectUri,
              ...(returnTo ? { returnTo } : {}),
            };
            yield* db
              .insert(verification)
              .values({
                id: uuidv7(),
                identifier: stateIdentifier(state),
                value: JSON.stringify(value),
                expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
              })
              .pipe(Effect.orDie);
            return {
              state,
              url: authorizeUrl({
                endpoint: adapter.oauth.authorizeUrl(config),
                clientId: row.oauthClientId,
                redirectUri,
                scopes: adapter.oauth.scopes,
                state,
                verifier,
              }),
            };
          },
        ),

        completeOAuth: Effect.fn("IntegrationService.completeOAuth")(
          function* (userId, integrationId, input) {
            const expired = new IntegrationRejected({
              reason:
                "This sign-in link expired or was opened in another browser. Start again from Settings.",
            });
            // The cookie ties the callback to the browser that started it: a
            // stranger's authorization link cannot land their account in ours.
            if (!input.cookieState || input.cookieState !== input.state) return yield* expired;
            const consumed = yield* db
              .delete(verification)
              .where(
                and(
                  eq(verification.identifier, stateIdentifier(input.state)),
                  gt(verification.expiresAt, new Date()),
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            const stored = consumed[0] ? (JSON.parse(consumed[0].value) as OAuthStateValue) : null;
            if (!stored || stored.userId !== userId || stored.integrationId !== integrationId)
              return yield* expired;
            const { adapter, row, config, fingerprint } = yield* available(userId, integrationId);
            if (!adapter.oauth || !row.oauthClientId) return yield* expired;
            const outcome = yield* requestTokens({
              endpoint: adapter.oauth.tokenUrl(config),
              clientId: row.oauthClientId,
              clientSecret: yield* repo.clientSecret(row),
              params: {
                grant_type: "authorization_code",
                code: input.code,
                redirect_uri: stored.redirectUri,
                code_verifier: stored.verifier,
              },
            }).pipe(
              Effect.catchTag("IntegrationRequestFailed", (error) =>
                Effect.fail(new IntegrationRejected({ reason: error.message })),
              ),
            );
            if (!outcome.ok)
              return yield* new IntegrationRejected({
                reason: "The service refused the sign-in. Try again.",
              });
            const { accountLabel } = yield* verified(adapter, config, {
              kind: "oauth",
              accessToken: outcome.tokens.accessToken,
            });
            yield* repo.saveConnection({
              userId,
              integrationId,
              authKind: "oauth",
              credentials: { kind: "oauth", ...outcome.tokens },
              accountLabel,
              fingerprint,
            });
            yield* changed(userId);
            return { returnTo: stored.returnTo ?? null };
          },
        ),

        updatePreferences: Effect.fn("IntegrationService.updatePreferences")(
          function* (userId, integrationId, input) {
            let scope = input.scope;
            if (scope) {
              if (!findIntegration(integrationId)?.scope)
                return yield* new IntegrationRejected({
                  reason: "This integration has no limits.",
                });
              // Empty is a choice too: the connection then reaches nothing.
              scope = [...new Set(scope.map((item) => item.trim()).filter(Boolean))];
              if (scope.length > MAX_SCOPE_ITEMS)
                return yield* new IntegrationRejected({
                  reason: `Pick at most ${MAX_SCOPE_ITEMS}.`,
                });
            }
            const updated = yield* repo.updatePreferences(userId, integrationId, {
              ...input,
              ...(scope === undefined ? {} : { scope }),
            });
            if (!updated) return yield* new IntegrationNotAvailable({ integrationId });
            yield* changed(userId);
          },
        ),

        scopeOptions: Effect.fn("IntegrationService.scopeOptions")(
          function* (userId, integrationId) {
            const session = yield* sessionFor(userId, integrationId);
            if (!session.adapter.scopeOptions)
              return yield* new IntegrationRejected({ reason: "This integration has no limits." });
            return yield* session.adapter.scopeOptions(session).pipe(
              Effect.catchTags({
                IntegrationAuthFailed: () =>
                  Effect.fail(
                    new IntegrationRejected({ reason: "The saved sign-in no longer works." }),
                  ),
                IntegrationRequestFailed: (error) =>
                  Effect.fail(new IntegrationRejected({ reason: error.message })),
              }),
            );
          },
        ),

        disconnect: Effect.fn("IntegrationService.disconnect")(function* (userId, integrationId) {
          yield* repo.removeConnection(userId, integrationId);
          yield* changed(userId);
        }),

        session: (userId, integrationId) => sessionFor(userId, integrationId),

        reportAuthFailure: Effect.fn("IntegrationService.reportAuthFailure")(function* (input) {
          yield* repo.markNeedsReauth(input.connectionId);
          yield* changed(input.userId);
        }),
      });
    }),
  );
}
