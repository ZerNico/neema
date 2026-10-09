import { isIP } from "node:net";
import { and, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { integrationConfigs, integrationConnections, verification } from "~/db/schema/index.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { publicUrl } from "~/server/public-url.ts";
import { findIntegrationType, INTEGRATION_TYPES } from "../catalog.ts";
import {
  IntegrationAuthFailed,
  IntegrationNotAvailable,
  IntegrationRejected,
  IntegrationRequestFailed,
} from "../errors.ts";
import type { ToolPermission, UnattendedGrant } from "../consent.ts";
import type { IntegrationGrant } from "../grant.ts";
import type { AdminCatalog, AdminIntegration, ScopeOption, UserIntegration } from "../schema.ts";
import { readFields } from "../fields.ts";
import type { IntegrationManifest } from "../manifest.ts";
import type {
  CatalogDecision,
  ConnectMethods,
  Credential,
  IntegrationAdapter,
  IntegrationSession,
  OfferedTool,
} from "./adapter.ts";
import { findAdapterType } from "./adapters.ts";
import { shippedTools } from "./tools.ts";
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
  type DiscoveredServer,
  type IntegrationConnectionRow,
  type SaveConfig,
  type StoredCredentials,
  type ToolCatalogRow,
} from "./repo.ts";

/** How soon a catalog is looked at again after a check failed, and by default after one worked. */
const CATALOG_RETRY_MS = 60 * 60_000;
const CATALOG_RECHECK_MS = 24 * 60 * 60_000;

const failureReason = (error: { _tag: string }) =>
  error._tag === "IntegrationAuthFailed"
    ? "The server refused the sign-in used to list its tools."
    : "reason" in error && typeof error.reason === "string"
      ? error.reason
      : "message" in error && typeof error.message === "string"
        ? error.message
        : "The server could not be reached.";

/**
 * Where an authorization server could fetch this app's client metadata
 * document: only an operator-declared public HTTPS address, since a server
 * that cannot reach the document fails the whole sign-in. Without one, the
 * app registers itself instead.
 */
const metadataDocumentOrigin = () => {
  const declared = publicUrl();
  if (!declared?.startsWith("https://")) return null;
  const host = new URL(declared).hostname;
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isIP(host.replace(/^\[|\]$/g, "")) !== 0 ||
    !host.includes(".");
  return local ? null : declared;
};

const UNAVAILABLE = "This integration is no longer available.";

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
  /** Recorded when the sign-in was discovered: where the code goes, and who must answer. */
  server?: DiscoveredServer;
  /**
   * The integration's revision the sign-in started under. Tokens are only
   * kept for that one: a setup changed meanwhile must not get them.
   */
  revision?: number;
}

export interface ConnectedSession extends IntegrationSession {
  readonly connectionId: string;
  /** Which integration this is: its id, the type it runs on and its name. */
  readonly integration: { readonly id: string; readonly kind: string; readonly name: string };
  readonly adapter: IntegrationAdapter;
  /** What this integration offers, in a stable order: shipped, or its approved catalog. */
  readonly tools: ReadonlyArray<OfferedTool>;
  /** `shared` acts as the admin's account for everyone, so only reads are offered. */
  readonly authKind: IntegrationConnectionRow["authKind"];
}

/** One integration as a chat sees it: whether it is on here, and how much it asks. */
export interface ChatIntegration {
  integrationId: string;
  kind: string;
  name: string;
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

/**
 * The setup a piece of work started under: the fingerprint names the server
 * and the way in, the revision tells apart two saves of the same one (moved
 * away and back). Work that started under one must not finish under another.
 */
interface Setup {
  readonly fingerprint: string;
  readonly revision: number;
}

type RefreshResult =
  | { kind: "credential"; credential: Credential }
  | { kind: "revoked" }
  | { kind: "failed"; message: string };

const oauthReady = (
  row: Pick<IntegrationConfigRow, "oauthClientId" | "oauthClientSecretCiphertext"> | null,
) => Boolean(row?.oauthClientId && row.oauthClientSecretCiphertext);

/**
 * How people may connect right now. A type whose config decides it (MCP)
 * says so itself; otherwise OAuth needs the admin's client and keys need the
 * admin's switch. A shared key counts only once one is stored.
 */
const methodsFor = (
  manifest: IntegrationManifest,
  adapter: IntegrationAdapter,
  row: Pick<IntegrationConfigRow, "oauthClientId" | "oauthClientSecretCiphertext" | "allowApiKeys">,
  config: Readonly<Record<string, string>>,
  sharedStored: boolean,
): ConnectMethods => {
  if (adapter.connectMethods) {
    const declared = adapter.connectMethods(config);
    return {
      oauth: declared.oauth && Boolean(adapter.discoveredOAuth),
      apiKey: declared.apiKey && Boolean(manifest.apiKey),
      open: declared.open === "shared" && !sharedStored ? null : declared.open,
    };
  }
  return {
    oauth: Boolean(manifest.oauth && adapter.oauth && oauthReady(row)),
    apiKey: Boolean(manifest.apiKey && row.allowApiKeys),
    open: null,
  };
};

/**
 * What a review names: this listing, and how many approvals came before, so
 * a review approves exactly what it showed and two admins cannot both win.
 */
const reviewVersion = (row: ToolCatalogRow) => `${row.listingId}.${row.reviewSeq}`;

const toCatalog = (row: ToolCatalogRow | null): AdminCatalog => ({
  approved: row?.approved ?? [],
  latest: row?.latest ?? null,
  server: row?.server ?? null,
  checkedAt: row?.checkedAt?.toISOString() ?? null,
  checkError: row?.checkError ?? null,
  reviewedAt: row?.reviewedAt?.toISOString() ?? null,
  version: row?.latest && row.listingId ? reviewVersion(row) : null,
});

const toAdmin = (
  row: IntegrationConfigRow & { connectionCount: number },
  catalog: AdminCatalog | null,
): AdminIntegration => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  enabled: row.enabled,
  config: row.config,
  oauthClientId: row.oauthClientId,
  oauthSecretConfigured: Boolean(row.oauthClientSecretCiphertext),
  allowApiKeys: row.allowApiKeys,
  audience: row.audience,
  connectionCount: row.connectionCount,
  sharedCredentialConfigured: Boolean(row.sharedCredentialCiphertext),
  catalog,
});

const NAME_MAX = 60;

const byName = <A extends { name: string }>(a: A, b: A) => a.name.localeCompare(b.name);

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
    /** Every integration's id, type and name, for showing stored references anywhere. */
    directory(): Effect.Effect<ReadonlyArray<{ id: string; kind: string; name: string }>>;
    /** A new integration of a shipped type, off until set up. */
    /** Adds an integration of a type; the server picks its id. */
    createIntegration(input: {
      kind: string;
      name: string;
    }): Effect.Effect<AdminIntegration, IntegrationRejected>;
    deleteIntegration(id: string): Effect.Effect<void, IntegrationRejected>;
    saveConfig(
      input: Omit<SaveConfig, "fingerprint" | "listsTools">,
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
      input: { code: string; state: string; cookieState: string | null; iss: string | null },
    ): Effect.Effect<{ returnTo: string | null }, IntegrationNotAvailable | IntegrationRejected>;
    /** Turns on an integration that needs no personal credential: open, or the admin's key. */
    connectOpen(
      userId: string,
      integrationId: string,
    ): Effect.Effect<void, IntegrationNotAvailable | IntegrationRejected>;
    /**
     * Lists a catalog type's tools from its server now, as the given admin, or
     * as whoever last reviewed it. Nothing becomes offered by this alone.
     */
    checkCatalog(
      integrationId: string,
      asUserId: string | null,
    ): Effect.Effect<AdminCatalog, IntegrationRejected>;
    /** What the admin approved becomes what chats are offered. */
    approveCatalog(
      adminId: string,
      integrationId: string,
      input: { version: string; decisions: ReadonlyArray<CatalogDecision> },
    ): Effect.Effect<AdminCatalog, IntegrationRejected>;
    /** Catalog checks due now, claimed under a lease; the sweep calls this. */
    checkDueCatalogs(): Effect.Effect<void>;
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
    /** Records scopes a call lacked, so Settings offers to grant them. */
    reportMissingScopes(
      connection: { userId: string; connectionId: string },
      scopes: ReadonlyArray<string>,
    ): Effect.Effect<void>;
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

      const toolsOf = Effect.fn(function* (
        manifest: IntegrationManifest,
        adapter: IntegrationAdapter,
        integrationId: string,
      ) {
        if (manifest.toolSource === "static") return shippedTools(manifest, adapter);
        const catalog = adapter.catalog;
        if (!catalog) return [];
        const row = yield* repo.catalog(integrationId);
        if (!row) return [];
        return catalog.offer(row.approved, row.latest).flatMap((entry) => {
          const tool = catalog.tool(integrationId, entry);
          return tool ? [tool] : [];
        });
      });

      /**
       * The secret for a discovered sign-in's client: the admin's when it is
       * their registered client, else the one this app registered with that
       * issuer. A metadata document client has none.
       */
      const discoveredSecret = Effect.fn(function* (
        row: IntegrationConfigRow,
        server: DiscoveredServer,
      ) {
        // The admin's secret goes only to the issuer their client is pinned to.
        if (row.oauthClientId && server.clientId === row.oauthClientId)
          return row.oauthClientIssuer === server.issuer ? yield* repo.clientSecret(row) : null;
        const registered = yield* repo.oauthClient(row.id, server.issuer, server.clientId);
        return registered?.clientSecret ?? null;
      });

      const adminView = Effect.fn(function* (
        row: IntegrationConfigRow & { connectionCount: number },
      ) {
        const manifest = findIntegrationType(row.kind);
        const adapter = findAdapterType(row.kind);
        const catalog =
          manifest?.toolSource === "catalog" && adapter
            ? toCatalog(yield* repo.catalog(row.id))
            : null;
        return toAdmin(row, catalog);
      });

      /** The integration with its type, adapter and normalized config, or why it cannot be used. */
      const available = Effect.fn(function* (userId: string, integrationId: string) {
        const row = yield* repo.getConfig(integrationId);
        const manifest = row ? findIntegrationType(row.kind) : null;
        const adapter = row ? findAdapterType(row.kind) : null;
        if (
          !row?.enabled ||
          !manifest ||
          !adapter ||
          !(yield* repo.isUsable(userId, integrationId))
        )
          return yield* new IntegrationNotAvailable({ integrationId });
        const normalized = adapter.normalizeConfig(row.config);
        if ("error" in normalized) return yield* new IntegrationNotAvailable({ integrationId });
        return { manifest, adapter, row, ...normalized };
      });

      const refresh = (
        connectionId: string,
        row: IntegrationConfigRow,
        adapter: IntegrationAdapter,
        setup: Setup,
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
                // Checked again under the lock, the integration's row held too: a
                // reconnect after a move must not hand this session the new server's token.
                const [config] = yield* tx
                  .select({ revision: integrationConfigs.revision })
                  .from(integrationConfigs)
                  .where(eq(integrationConfigs.id, row.id))
                  .for("share");
                if (
                  locked.status !== "active" ||
                  locked.configFingerprint !== setup.fingerprint ||
                  config?.revision !== setup.revision
                )
                  return { kind: "failed", message: UNAVAILABLE } satisfies RefreshResult;
                const stored = yield* repo.decrypt(locked);
                if (stored?.kind === "api_key")
                  return {
                    kind: "credential",
                    credential: { kind: "api_key", values: stored.values },
                  } satisfies RefreshResult;
                if (stored?.kind === "none")
                  return {
                    kind: "credential",
                    credential: { kind: "none" },
                  } satisfies RefreshResult;
                if (
                  stored &&
                  (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
                )
                  return {
                    kind: "credential",
                    credential: { kind: "oauth", accessToken: stored.accessToken },
                  } satisfies RefreshResult;
                const discovered = stored?.server && adapter.discoveredOAuth ? stored.server : null;
                if (!stored?.refreshToken || (!discovered && (!oauth || !row.oauthClientId))) {
                  yield* tx
                    .update(integrationConnections)
                    .set({ status: "needs_reauth", updatedAt: new Date() })
                    .where(eq(integrationConnections.id, connectionId));
                  return { kind: "revoked" } satisfies RefreshResult;
                }
                const outcome = discovered
                  ? yield* adapter.discoveredOAuth!.refresh({
                      server: discovered,
                      clientSecret: yield* discoveredSecret(row, discovered),
                      refreshToken: stored.refreshToken,
                    })
                  : yield* requestTokens({
                      endpoint: oauth!.tokenUrl(row.config),
                      clientId: row.oauthClientId!,
                      clientSecret,
                      params: { grant_type: "refresh_token", refresh_token: stored.refreshToken },
                    }).pipe(
                      Effect.catchTag("IntegrationRequestFailed", () =>
                        Effect.succeed({ ok: false as const, revoked: false }),
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
                  ...(discovered ? { server: discovered } : {}),
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

      /**
       * The connection's credential for the setup a session was made for. A
       * session keeps the address it started with, so a credential from a
       * later setup (a move, then a reconnect) must never be paired with it.
       */
      const credentialFor = (
        connection: IntegrationConnectionRow,
        row: IntegrationConfigRow,
        adapter: IntegrationAdapter,
        setup: Setup,
      ): Effect.Effect<Credential, IntegrationAuthFailed | IntegrationRequestFailed> =>
        Effect.gen(function* () {
          const current = yield* repo.getConnectionById(connection.id);
          if (!current || current.status !== "active")
            return yield* new IntegrationAuthFailed({ integrationId: row.id });
          const enabled = yield* available(connection.userId, row.id).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (
            !enabled ||
            enabled.fingerprint !== setup.fingerprint ||
            enabled.row.revision !== setup.revision ||
            current.configFingerprint !== setup.fingerprint
          )
            return yield* new IntegrationRequestFailed({ status: null, message: UNAVAILABLE });
          // The admin's key, read fresh: replacing it applies to the next call.
          if (current.authKind === "shared") {
            const shared = yield* repo.sharedCredential(enabled.row);
            if (!shared) return yield* new IntegrationAuthFailed({ integrationId: row.id });
            return { kind: "api_key", values: shared };
          }
          const stored = yield* repo.decrypt(current);
          if (stored?.kind === "none") return { kind: "none" };
          if (stored?.kind === "api_key") return { kind: "api_key", values: stored.values };
          if (
            stored &&
            (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
          )
            return { kind: "oauth", accessToken: stored.accessToken };
          // Expired or unreadable: refreshing decides under the row lock.
          const result = yield* refresh(connection.id, row, adapter, setup);
          if (result.kind === "credential") return result.credential;
          if (result.kind === "revoked") {
            yield* changed(connection.userId);
            return yield* new IntegrationAuthFailed({ integrationId: row.id });
          }
          return yield* new IntegrationRequestFailed({ status: null, message: result.message });
        });

      const sessionFor = Effect.fn("IntegrationService.session")(function* (
        userId: string,
        integrationId: string,
      ) {
        const { manifest, adapter, row, config, fingerprint } = yield* available(
          userId,
          integrationId,
        );
        const connection = yield* repo.getConnection(userId, integrationId);
        if (
          !connection ||
          connection.status !== "active" ||
          connection.configFingerprint !== fingerprint
        )
          return yield* new IntegrationNotAvailable({ integrationId });
        const session: ConnectedSession = {
          connectionId: connection.id,
          integration: { id: row.id, kind: row.kind, name: row.name },
          adapter,
          tools: yield* toolsOf(manifest, adapter, row.id),
          authKind: connection.authKind,
          config,
          credential: credentialFor(connection, row, adapter, {
            fingerprint,
            revision: row.revision,
          }),
          // Read fresh, so narrowing it applies to an answer already running.
          // A connection gone meanwhile reaches nothing.
          scope: manifest.scope
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
        const usable = new Map<
          string,
          { connection: IntegrationConnectionRow; config: IntegrationConfigRow }
        >();
        for (const row of rows) {
          const adapter = findAdapterType(row.config.kind);
          if (!adapter || !row.config.enabled || !row.usable || !row.connection) continue;
          const normalized = adapter.normalizeConfig(row.config.config);
          if ("error" in normalized) continue;
          if (row.connection.status !== "active") continue;
          if (row.connection.configFingerprint !== normalized.fingerprint) continue;
          usable.set(row.config.id, { connection: row.connection, config: row.config });
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
        for (const { connection, config } of [...usable.values()].toSorted((a, b) =>
          byName(a.config, b.config),
        )) {
          const own = settings.find((entry) => entry.integrationId === config.id);
          const defaultEnabled = attached
            ? attached.includes(config.id)
            : connection.offerByDefault;
          result.push({
            integrationId: config.id,
            kind: config.kind,
            name: config.name,
            accountLabel: connection.accountLabel,
            enabled: own?.enabled ?? defaultEnabled,
            defaultEnabled,
          });
        }
        return result;
      });

      /**
       * A session to list a catalog with. An open or shared server needs nobody;
       * otherwise it is a person's own connection, since listing may show what
       * only an account can see.
       */
      const catalogSession = Effect.fn(function* (integrationId: string, userId: string | null) {
        const row = yield* repo.getConfig(integrationId);
        const manifest = row ? findIntegrationType(row.kind) : null;
        const adapter = row ? findAdapterType(row.kind) : null;
        const catalog = adapter?.catalog;
        if (!row || !manifest || !adapter || !catalog)
          return yield* new IntegrationRejected({
            reason: "This integration does not list its own tools.",
          });
        // A switched-off integration reaches nobody, the admin's key included.
        if (!row.enabled)
          return yield* new IntegrationRejected({ reason: `Turn ${row.name} on first.` });
        const normalized = adapter.normalizeConfig(row.config);
        if ("error" in normalized)
          return yield* new IntegrationRejected({ reason: normalized.error });
        const methods = methodsFor(
          manifest,
          adapter,
          row,
          normalized.config,
          Boolean(row.sharedCredentialCiphertext),
        );
        if (methods.open) {
          const shared = methods.open === "shared" ? yield* repo.sharedCredential(row) : null;
          if (methods.open === "shared" && !shared)
            return yield* new IntegrationRejected({ reason: "Enter the shared key first." });
          const credential: Credential = shared
            ? { kind: "api_key", values: shared }
            : { kind: "none" };
          return { row, adapter, catalog, session: probe(normalized.config, credential) };
        }
        const connectFirst = new IntegrationRejected({
          reason: `Turn ${row.name} on and connect your own account in Settings, then check again.`,
        });
        if (!userId) return yield* connectFirst;
        const session = yield* sessionFor(userId, integrationId).pipe(
          Effect.mapError(() => connectFirst),
        );
        return { row, adapter, catalog, session };
      });

      const checkCatalog = Effect.fn("IntegrationService.checkCatalog")(function* (
        integrationId: string,
        asUserId: string | null,
      ) {
        const token = yield* repo.startCatalogCheck(integrationId);
        const current = yield* repo.catalog(integrationId);
        // Recorded only for the setup the check started under: a move meanwhile drops it.
        const started = (yield* repo.getConfig(integrationId))?.revision ?? 0;
        const fail = (reason: string) =>
          repo
            .recordCatalogCheck(
              integrationId,
              { token, revision: started },
              { error: reason },
              new Date(Date.now() + CATALOG_RETRY_MS),
            )
            .pipe(Effect.andThen(Effect.fail(new IntegrationRejected({ reason }))));
        const context = yield* catalogSession(
          integrationId,
          asUserId ?? current?.reviewedBy ?? null,
        ).pipe(Effect.catch((error) => fail(error.reason)));
        if (context.row.revision !== started)
          return yield* fail("The integration changed while it was being checked. Check again.");
        // Approved names win, so nothing approved is renamed for the model.
        const previous = [...(current?.latest ?? []), ...(current?.approved ?? [])];
        const listed = yield* context.catalog
          .list(context.session, integrationId, previous)
          .pipe(Effect.catch((error) => fail(failureReason(error))));
        const next = new Date(Date.now() + (listed.recheckAfterMs ?? CATALOG_RECHECK_MS));
        // A newer check, or the admin moving the server, made this listing stale: drop it.
        const recorded = yield* repo.recordCatalogCheck(
          integrationId,
          { token, revision: started },
          { latest: listed.entries, server: listed.server },
          next,
        );
        if (!recorded)
          return yield* new IntegrationRejected({
            reason: "A newer check of this server replaced this one. Look again.",
          });
        yield* bus
          .publishGlobal({ type: "integrations.changed" })
          .pipe(Effect.catchCause(() => Effect.void));
        return toCatalog(yield* repo.catalog(integrationId));
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
                scope: findIntegrationType(session.value.integration.kind)?.scope
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
            if (!(yield* repo.getConfig(integrationId)))
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
          return yield* Effect.forEach(
            rows.filter((row) => findIntegrationType(row.kind)).toSorted(byName),
            adminView,
          );
        }),

        directory: Effect.fn("IntegrationService.directory")(function* () {
          const rows = yield* repo.listConfigs();
          return rows
            .toSorted(byName)
            .map((row) => ({ id: row.id, kind: row.kind, name: row.name }));
        }),

        createIntegration: Effect.fn("IntegrationService.createIntegration")(function* (input) {
          if (!findIntegrationType(input.kind) || !findAdapterType(input.kind))
            return yield* new IntegrationRejected({ reason: "Unknown integration type." });
          const name = input.name.trim();
          if (!name || name.length > NAME_MAX)
            return yield* new IntegrationRejected({ reason: "Give it a name." });
          if (yield* repo.nameTaken(name, null))
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          const id = yield* repo.createConfig({ kind: input.kind, name });
          if (!id)
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
          const created = (yield* repo.listConfigs()).find((entry) => entry.id === id);
          return yield* adminView(created!);
        }),

        deleteIntegration: Effect.fn("IntegrationService.deleteIntegration")(function* (id) {
          const outcome = yield* repo.deleteConfig(id);
          if (!outcome.deleted)
            return yield* new IntegrationRejected({
              reason: `${outcome.sources} knowledge ${outcome.sources === 1 ? "source mirrors" : "sources mirror"} it. Remove ${outcome.sources === 1 ? "it" : "them"} first.`,
            });
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
        }),

        saveConfig: Effect.fn("IntegrationService.saveConfig")(function* (input) {
          const stored = yield* repo.getConfig(input.id);
          const manifest = stored ? findIntegrationType(stored.kind) : null;
          const adapter = stored ? findAdapterType(stored.kind) : null;
          if (!stored || !manifest || !adapter)
            return yield* new IntegrationRejected({ reason: "Unknown integration." });
          const name = input.name.trim();
          if (!name || name.length > NAME_MAX)
            return yield* new IntegrationRejected({ reason: "Give it a name." });
          if (yield* repo.nameTaken(name, input.id))
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          const known = new Set(manifest.adminFields.map((field) => field.key));
          const config = Object.fromEntries(
            Object.entries(input.config).filter(([key]) => known.has(key)),
          );
          const normalized = adapter.normalizeConfig(config);
          if ("error" in normalized)
            return yield* new IntegrationRejected({ reason: normalized.error });
          const clientId = input.oauthClientId?.trim() || null;
          const willHaveSecret =
            input.oauthClientSecret === undefined
              ? Boolean(stored.oauthClientSecretCiphertext)
              : input.oauthClientSecret !== "";
          // A discovered sign-in may use a public client the admin registered, with no secret.
          if (clientId && !willHaveSecret && manifest.oauth && !adapter.discoveredOAuth)
            return yield* new IntegrationRejected({ reason: "Enter the OAuth client secret too." });
          let sharedCredential = input.sharedCredential;
          if (sharedCredential && manifest.sharedCredential) {
            const read = readFields(manifest.sharedCredential.fields, sharedCredential);
            if ("error" in read) return yield* new IntegrationRejected({ reason: read.error });
            sharedCredential = read.values;
          } else if (sharedCredential) sharedCredential = undefined;
          const willHaveShared =
            sharedCredential === undefined
              ? Boolean(stored.sharedCredentialCiphertext)
              : sharedCredential !== null;
          const methods = methodsFor(
            manifest,
            adapter,
            {
              oauthClientId: clientId,
              oauthClientSecretCiphertext: willHaveSecret ? "set" : null,
              allowApiKeys: input.allowApiKeys,
            },
            normalized.config,
            willHaveShared,
          );
          if (input.enabled && !methods.oauth && !methods.apiKey && methods.open === null)
            return yield* new IntegrationRejected({
              reason: adapter.connectMethods
                ? "Enter the shared key before turning this on."
                : "Set up OAuth or allow personal API keys before turning this on.",
            });
          // Approval was of one server, not of words: another server starts the review over.
          const row = yield* repo.saveConfig({
            ...input,
            name,
            oauthClientId: clientId,
            config: normalized.config,
            fingerprint: normalized.fingerprint,
            sharedCredential,
            listsTools: manifest.toolSource === "catalog",
          });
          if (!row) return yield* new IntegrationRejected({ reason: "Unknown integration." });
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
          const counted = (yield* repo.listConfigs()).find((entry) => entry.id === row.id);
          return yield* adminView(counted!);
        }),

        listForUser: Effect.fn("IntegrationService.listForUser")(function* (userId) {
          const rows = yield* repo.listForUser(userId);
          const result: UserIntegration[] = [];
          for (const entry of rows.toSorted((a, b) => byName(a.config, b.config))) {
            const manifest = findIntegrationType(entry.config.kind);
            const adapter = findAdapterType(entry.config.kind);
            if (!manifest || !adapter) continue;
            const normalized = adapter.normalizeConfig(entry.config.config);
            const configured = !("error" in normalized);
            const methods = methodsFor(
              manifest,
              adapter,
              entry.config,
              configured ? normalized.config : {},
              Boolean(entry.config.sharedCredentialCiphertext),
            );
            const open =
              entry.config.enabled &&
              entry.usable &&
              configured &&
              (methods.oauth || methods.apiKey || methods.open !== null);
            // A connection outlives its integration being switched off, so it
            // still shows (and can be removed) even when nothing new may start.
            if (!open && !entry.connection) continue;
            const connection = entry.connection;
            const stale =
              connection !== null &&
              configured &&
              connection.configFingerprint !== normalized.fingerprint;
            result.push({
              id: entry.config.id,
              kind: entry.config.kind,
              name: entry.config.name,
              available: open,
              methods,
              // A shared key only ever reads, so its other tools are not anyone's to set.
              tools: (yield* toolsOf(manifest, adapter, entry.config.id))
                .filter((tool) => methods.open !== "shared" || tool.access === "read")
                .map((tool) => ({
                  name: tool.name,
                  title: tool.title,
                  label: tool.label,
                  description: tool.description,
                  access: tool.access,
                })),
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
                    requiredScopes: connection.requiredScopes,
                    createdAt: connection.createdAt.toISOString(),
                  }
                : null,
              dependents: connection
                ? yield* repo.dependents(userId, entry.config.id)
                : { sources: 0, schedules: 0 },
            });
          }
          return result;
        }),

        connectApiKey: Effect.fn("IntegrationService.connectApiKey")(
          function* (userId, integrationId, input) {
            const { manifest, adapter, row, config, fingerprint } = yield* available(
              userId,
              integrationId,
            );
            const form = manifest.apiKey;
            // The same rule Settings shows: an MCP server set to sign-in or the
            // shared key takes no personal token, whatever the old switch says.
            const methods = methodsFor(
              manifest,
              adapter,
              row,
              config,
              Boolean(row.sharedCredentialCiphertext),
            );
            if (!methods.apiKey || !form)
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

        checkCatalog: (integrationId, asUserId) => checkCatalog(integrationId, asUserId),

        approveCatalog: Effect.fn("IntegrationService.approveCatalog")(
          function* (adminId, integrationId, input) {
            const row = yield* repo.getConfig(integrationId);
            const adapter = row ? findAdapterType(row.kind) : null;
            const catalog = adapter?.catalog;
            if (!row || !adapter || !catalog)
              return yield* new IntegrationRejected({
                reason: "This integration does not list its own tools.",
              });
            const current = yield* repo.catalog(integrationId);
            if (!current?.latest || !current.listingId)
              return yield* new IntegrationRejected({ reason: "Check the server’s tools first." });
            const outdated = new IntegrationRejected({
              reason: "The server’s tools changed while you were looking. Review them again.",
            });
            // Approving is approving what was seen: another listing, or another
            // approval since, is shown again rather than overwritten.
            if (reviewVersion(current) !== input.version) return yield* outdated;
            const applied = catalog.apply(current.approved, current.latest, input.decisions);
            if ("error" in applied)
              return yield* new IntegrationRejected({ reason: applied.error });
            const written = yield* repo.approveCatalog(integrationId, applied.approved, adminId, {
              listingId: current.listingId,
              reviewSeq: current.reviewSeq,
            });
            if (!written) return yield* outdated;
            yield* bus
              .publishGlobal({ type: "integrations.changed" })
              .pipe(Effect.catchCause(() => Effect.void));
            return toCatalog(yield* repo.catalog(integrationId));
          },
        ),

        checkDueCatalogs: Effect.fn("IntegrationService.checkDueCatalogs")(function* () {
          const kinds = INTEGRATION_TYPES.filter((type) => type.toolSource === "catalog").map(
            (type) => type.kind,
          );
          const claimed = yield* repo.claimCatalogChecks({ kinds, limit: 5, leaseMs: 5 * 60_000 });
          yield* Effect.forEach(
            claimed,
            (entry) => checkCatalog(entry.integrationId, null).pipe(Effect.ignore),
            { concurrency: 3, discard: true },
          );
        }),

        connectOpen: Effect.fn("IntegrationService.connectOpen")(function* (userId, integrationId) {
          const { manifest, adapter, row, config, fingerprint } = yield* available(
            userId,
            integrationId,
          );
          const sharedStored = Boolean(row.sharedCredentialCiphertext);
          const open = methodsFor(manifest, adapter, row, config, sharedStored).open;
          if (!open)
            return yield* new IntegrationRejected({
              reason: "Connect this integration with your own account.",
            });
          const shared = open === "shared" ? yield* repo.sharedCredential(row) : null;
          if (open === "shared" && !shared)
            return yield* new IntegrationRejected({ reason: "The shared key is not set up." });
          const { accountLabel } = yield* verified(
            adapter,
            config,
            shared ? { kind: "api_key", values: shared } : { kind: "none" },
          );
          yield* repo.saveConnection({
            userId,
            integrationId,
            authKind: open,
            credentials: { kind: "none" },
            accountLabel,
            fingerprint,
          });
          yield* changed(userId);
        }),

        beginOAuth: Effect.fn("IntegrationService.beginOAuth")(
          function* (userId, integrationId, origin, returnTo) {
            const { manifest, adapter, row, config } = yield* available(userId, integrationId);
            const state = randomToken();
            const redirectUri = `${origin}${callbackPath(integrationId)}`;
            const store = (value: OAuthStateValue) =>
              db
                .insert(verification)
                .values({
                  id: uuidv7(),
                  identifier: stateIdentifier(state),
                  value: JSON.stringify(value),
                  expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
                })
                .pipe(Effect.orDie);
            const discovered = adapter.discoveredOAuth;
            if (discovered) {
              if (!methodsFor(manifest, adapter, row, config, false).oauth)
                return yield* new IntegrationRejected({
                  reason: "This integration does not use sign-in.",
                });
              // A step-up keeps what was granted and asks for what a call lacked.
              const connection = yield* repo.getConnection(userId, integrationId);
              const previous = connection ? yield* repo.decrypt(connection) : null;
              const granted =
                previous?.kind === "oauth" && previous.server ? previous.server.scopes : [];
              const started = yield* discovered.begin({
                config,
                integrationId,
                integrationName: row.name,
                redirectUri,
                clientMetadataUrl: metadataDocumentOrigin()
                  ? `${metadataDocumentOrigin()}/api/integrations/${integrationId}/oauth-client`
                  : null,
                state,
                scopes: { granted, required: connection?.requiredScopes ?? [] },
                preregistered: row.oauthClientId
                  ? {
                      clientId: row.oauthClientId,
                      clientSecret: yield* repo.clientSecret(row),
                      pin: (issuer: string) =>
                        repo.pinClientIssuer(integrationId, row.revision, issuer),
                    }
                  : null,
                storedClient: (issuer) =>
                  repo.reusableOAuthClient(integrationId, issuer, redirectUri),
                saveClient: (issuer, client) => repo.saveOAuthClient(integrationId, issuer, client),
              });
              yield* store({
                userId,
                integrationId,
                verifier: started.verifier,
                redirectUri,
                server: started.server,
                revision: row.revision,
                ...(returnTo ? { returnTo } : {}),
              });
              return { state, url: started.url };
            }
            if (!adapter.oauth || !row.oauthClientId || !row.oauthClientSecretCiphertext)
              return yield* new IntegrationRejected({
                reason: "OAuth is not set up for this integration.",
              });
            const verifier = randomToken();
            const value: OAuthStateValue = {
              userId,
              integrationId,
              verifier,
              redirectUri,
              revision: row.revision,
              ...(returnTo ? { returnTo } : {}),
            };
            yield* store(value);
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
            if (stored.revision !== row.revision)
              return yield* new IntegrationRejected({
                reason:
                  "This integration’s setup changed during the sign-in. Start again from Settings.",
              });
            if (stored.server && adapter.discoveredOAuth) {
              const tokens = yield* adapter.discoveredOAuth.complete({
                server: stored.server,
                clientSecret: yield* discoveredSecret(row, stored.server),
                code: input.code,
                iss: input.iss,
                verifier: stored.verifier,
                redirectUri: stored.redirectUri,
              });
              const { accountLabel } = yield* verified(adapter, config, {
                kind: "oauth",
                accessToken: tokens.accessToken,
              });
              const saved = yield* repo.saveConnection({
                userId,
                integrationId,
                authKind: "oauth",
                credentials: { kind: "oauth", ...tokens, server: stored.server },
                accountLabel,
                fingerprint,
              });
              yield* repo.clearRequiredScopes(saved.id);
              yield* changed(userId);
              return { returnTo: stored.returnTo ?? null };
            }
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
              const row = yield* repo.getConfig(integrationId);
              if (!(row && findIntegrationType(row.kind)?.scope))
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

        reportMissingScopes: Effect.fn("IntegrationService.reportMissingScopes")(
          function* (input, scopes) {
            const words = scopes.filter((scope) => /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/.test(scope));
            if (words.length === 0) return;
            yield* repo.addRequiredScopes(input.connectionId, words);
            yield* changed(input.userId);
          },
        ),
      });
    }),
  );
}
