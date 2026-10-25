import { and, eq } from "drizzle-orm";
import { Effect, Semaphore } from "effect";
import { uuidv7 } from "uuidv7";
import { integrationConfigs, integrationConnections } from "~/db/schema/index.ts";
import { Db, type DbTx } from "~/server/db.ts";
import { findIntegrationType } from "../catalog.ts";
import { accountName } from "../schema.ts";
import {
  IntegrationAuthFailed,
  IntegrationNotAvailable,
  IntegrationRejected,
  IntegrationRequestFailed,
} from "../errors.ts";
import type { IntegrationManifest } from "../manifest.ts";
import type {
  ConnectMethods,
  Credential,
  IntegrationAdapter,
  IntegrationSession,
  OfferedTool,
} from "./adapter.ts";
import { findAdapterType } from "./adapters.ts";
import { requestTokens, sha256 } from "./oauth.ts";
import {
  IntegrationRepo,
  integrationUsableBy,
  type IntegrationConfigRow,
  type DiscoveredServer,
  type IntegrationConnectionRow,
  type StoredCredentials,
} from "./repo.ts";

const UNAVAILABLE = "This integration is no longer available.";

/** Refresh this long before the service would expire the token. */
const REFRESH_MARGIN_MS = 60_000;

export interface ConnectedSession extends IntegrationSession {
  readonly connectionId: string;
  readonly accountEpoch: string;
  readonly configIdentity: string;
  /** Which integration this is: its id, the type it runs on and its name. */
  readonly integration: { readonly id: string; readonly kind: string; readonly name: string };
  readonly adapter: IntegrationAdapter;
  /** What this integration offers, in a stable order: shipped, or its approved catalog. */
  readonly tools: ReadonlyArray<OfferedTool>;
  /** `shared` acts as the admin's account for everyone, so only reads are offered. */
  readonly authKind: IntegrationConnectionRow["authKind"];
  /** What the person calls this account, as the session starts. */
  readonly account: string;
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

const configIdentity = (row: IntegrationConfigRow, adapter: IntegrationAdapter) => {
  const normalized = adapter.normalizeConfig(row.config);
  if ("error" in normalized) return null;
  return sha256(
    JSON.stringify({
      kind: row.kind,
      config: Object.entries(normalized.config).toSorted(([a], [b]) => a.localeCompare(b)),
      oauthClientId: row.oauthClientId,
      oauthClientSecretCiphertext: row.oauthClientSecretCiphertext,
    }),
  );
};

const credentialIdentity = (row: IntegrationConnectionRow) => ({
  connectionId: row.id,
  accountEpoch: row.accountEpoch,
  credentialRevision: row.credentialRevision,
});

const oauthReady = (
  row: Pick<IntegrationConfigRow, "oauthClientId" | "oauthClientSecretCiphertext"> | null,
) => Boolean(row?.oauthClientId && row.oauthClientSecretCiphertext);

/**
 * How people may connect right now. A type whose config decides it (MCP)
 * says so itself; otherwise OAuth needs the admin's client and keys need the
 * admin's switch. A shared key counts only once one is stored.
 */
export const methodsFor = (
  manifest: IntegrationManifest,
  adapter: IntegrationAdapter,
  row: Pick<IntegrationConfigRow, "oauthClientId" | "oauthClientSecretCiphertext" | "allowApiKeys">,
  config: Readonly<Record<string, string>>,
  sharedStored: boolean,
): ConnectMethods => {
  if (adapter.connectMethods) {
    const declared = adapter.connectMethods(config);
    const open = declared.open === "shared" && !sharedStored ? null : declared.open;
    return {
      oauth: declared.oauth && Boolean(adapter.discoveredOAuth),
      apiKey: declared.apiKey && Boolean(manifest.apiKey),
      open,
      everyone: open !== null && declared.everyone,
    };
  }
  return {
    oauth: Boolean(manifest.oauth && adapter.oauth && oauthReady(row)),
    apiKey: Boolean(manifest.apiKey && row.allowApiKeys),
    open: null,
    everyone: false,
  };
};

/**
 * Whether the way a connection was made is still one people may use. Only a
 * type whose config decides its ways (MCP) can close one under a connection;
 * the fingerprint names where credentials go, so it cannot tell.
 */
export const wayOpen = (
  manifest: IntegrationManifest,
  adapter: IntegrationAdapter,
  row: IntegrationConfigRow,
  config: Readonly<Record<string, string>>,
  kind: IntegrationConnectionRow["authKind"],
) => {
  if (!adapter.connectMethods) return true;
  const methods = methodsFor(
    manifest,
    adapter,
    row,
    config,
    Boolean(row.sharedCredentialCiphertext),
  );
  if (kind === "oauth") return methods.oauth;
  if (kind === "api_key") return methods.apiKey;
  return methods.open === kind;
};

/**
 * An integration as it may be used now, with its type, adapter and normalized
 * config, or null. `access` is `integrationUsableBy` for the person.
 */
export const integrationUsability = (row: IntegrationConfigRow, access: boolean) => {
  const manifest = findIntegrationType(row.kind);
  const adapter = findAdapterType(row.kind);
  if (!row.enabled || !access || !manifest || !adapter) return null;
  const normalized = adapter.normalizeConfig(row.config);
  if ("error" in normalized) return null;
  return { manifest, adapter, row, ...normalized };
};

/**
 * Whether an account works now, or why not: `unavailable` when its
 * integration is off, unshared or unconfigured, `needs_reauth` when the
 * account itself needs signing in again (refused, another server, a way in
 * closed). Settings, the schedule editor and save, a source's list and every
 * session decide by this alone, so none of them disagrees with a run.
 */
export const accountUsability = (
  row: IntegrationConfigRow,
  access: boolean,
  connection: Pick<IntegrationConnectionRow, "status" | "configFingerprint" | "authKind">,
) => {
  const integration = integrationUsability(row, access);
  if (!integration) return { usable: false, reason: "unavailable" } as const;
  if (
    connection.status !== "active" ||
    connection.configFingerprint !== integration.fingerprint ||
    !wayOpen(
      integration.manifest,
      integration.adapter,
      row,
      integration.config,
      connection.authKind,
    )
  )
    return { usable: false, reason: "needs_reauth" } as const;
  return { usable: true, ...integration } as const;
};

/** A session for a credential not stored yet, to verify it before saving. */
export const probe = (
  config: Record<string, string>,
  credential: Credential,
): IntegrationSession => ({
  config,
  credential: Effect.succeed(credential),
  scope: Effect.succeed(null),
});

export const verified = (
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

/**
 * Locks the config, then the connection, and checks both still describe
 * the setup this session was made for. No token touches a captured
 * endpoint until both locked identities still agree.
 */
const lockForRefresh = (
  tx: DbTx,
  connection: IntegrationConnectionRow,
  row: IntegrationConfigRow,
  adapter: IntegrationAdapter,
  setup: Setup,
) =>
  Effect.gen(function* () {
    // Config before connection, matching admin saves.
    const [config] = yield* tx
      .select()
      .from(integrationConfigs)
      .where(
        and(
          eq(integrationConfigs.id, row.id),
          eq(integrationConfigs.enabled, true),
          integrationUsableBy(connection.userId),
        ),
      )
      .for("share");
    if (
      !config ||
      configIdentity(config, adapter) !== configIdentity(row, adapter) ||
      config.revision !== setup.revision
    )
      return { kind: "failed", message: UNAVAILABLE } satisfies RefreshResult;
    const [locked] = yield* tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connection.id))
      .for("update");
    // A reconnect after a move must not hand this session the new server's token.
    if (
      !locked ||
      locked.status !== "active" ||
      locked.accountEpoch !== connection.accountEpoch ||
      locked.configFingerprint !== connection.configFingerprint ||
      locked.configFingerprint !== setup.fingerprint
    )
      return {
        kind: "failed",
        message: "This integration is no longer connected.",
      } satisfies RefreshResult;
    return { config, locked };
  });

const needsReauth = (tx: DbTx, connectionId: string) =>
  tx
    .update(integrationConnections)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));

/**
 * Working sessions as one person: the integration as it may be used now, and
 * a credential that is refreshed under the locks that keep it to one setup.
 */
export const makeCredentials = (deps: {
  /** What one account is offered; see `ConnectedSession.tools`. */
  toolsOf: (
    manifest: IntegrationManifest,
    adapter: IntegrationAdapter,
    row: IntegrationConfigRow,
    connection: { id: string; authKind: IntegrationConnectionRow["authKind"] } | null,
  ) => Effect.Effect<ReadonlyArray<OfferedTool>>;
  changed: (userId: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const repo = yield* IntegrationRepo;
    const { toolsOf, changed } = deps;

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

    /** The integration with its type, adapter and normalized config, or why it cannot be used. */
    const available = Effect.fn(function* (userId: string, integrationId: string) {
      const row = yield* repo.getConfig(integrationId);
      const usable = row ? integrationUsability(row, yield* repo.isUsable(userId, row.id)) : null;
      if (!usable) return yield* new IntegrationNotAvailable({ integrationId });
      return usable;
    });

    // Concurrent callers (a chat and a sync, say) take turns per connection:
    // the first rotates the refresh token, the rest find a fresh access token
    // instead of spending one already used. In process, so no pooled
    // connection or row lock is held while a token endpoint answers.
    const refreshTurns = new Map<string, Semaphore.Semaphore>();
    const refreshTurn = (connectionId: string) => {
      let turn = refreshTurns.get(connectionId);
      if (!turn) refreshTurns.set(connectionId, (turn = Semaphore.makeUnsafe(1)));
      return turn.withPermits(1);
    };

    const refresh = (
      connection: IntegrationConnectionRow,
      row: IntegrationConfigRow,
      adapter: IntegrationAdapter,
      setup: Setup,
    ) =>
      Effect.gen(function* () {
        const connectionId = connection.id;
        const oauth = adapter.oauth;
        // What to send, read under the locks; the request itself runs after commit.
        const plan = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const held = yield* lockForRefresh(tx, connection, row, adapter, setup);
              if ("kind" in held) return held;
              const { config, locked } = held;
              const stored = yield* repo.decrypt(locked);
              if (stored?.kind === "api_key")
                return {
                  kind: "credential",
                  credential: {
                    kind: "api_key",
                    values: stored.values,
                    identity: credentialIdentity(locked),
                  },
                } satisfies RefreshResult;
              if (stored?.kind === "none")
                return {
                  kind: "credential",
                  credential: { kind: "none", identity: credentialIdentity(locked) },
                } satisfies RefreshResult;
              if (
                stored &&
                (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
              )
                return {
                  kind: "credential",
                  credential: {
                    kind: "oauth",
                    accessToken: stored.accessToken,
                    identity: credentialIdentity(locked),
                  },
                } satisfies RefreshResult;
              const discovered = stored?.server && adapter.discoveredOAuth ? stored.server : null;
              if (!stored?.refreshToken || (!discovered && (!oauth || !row.oauthClientId))) {
                yield* needsReauth(tx, connectionId);
                return { kind: "revoked" } satisfies RefreshResult;
              }
              // Secrets come from the locked row: an issuer pinned meanwhile still holds.
              return {
                kind: "request",
                stored,
                refreshToken: stored.refreshToken,
                discovered,
                credentialRevision: locked.credentialRevision,
                clientSecret: discovered
                  ? yield* discoveredSecret(config, discovered)
                  : yield* repo.clientSecret(config),
              } as const;
            }),
          )
          .pipe(Effect.orDie);
        if (plan.kind !== "request") return plan as RefreshResult;

        const outcome = plan.discovered
          ? yield* adapter.discoveredOAuth!.refresh({
              config: row.config,
              server: plan.discovered,
              clientSecret: plan.clientSecret,
              refreshToken: plan.refreshToken,
            })
          : yield* requestTokens({
              endpoint: oauth!.tokenUrl(row.config),
              clientId: row.oauthClientId!,
              clientSecret: plan.clientSecret,
              params: { grant_type: "refresh_token", refresh_token: plan.refreshToken },
            }).pipe(
              Effect.catchTag("IntegrationRequestFailed", () =>
                Effect.succeed({ ok: false as const, revoked: false }),
              ),
            );
        if (!outcome.ok && !outcome.revoked)
          return { kind: "failed", message: "Could not refresh the sign-in." } as RefreshResult;

        // The provider has already spent the old refresh token, so the answer
        // is kept whenever the connection is still the one that was read. A
        // setup changed meanwhile only means this session does not get it.
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [locked] = yield* tx
                .select()
                .from(integrationConnections)
                .where(eq(integrationConnections.id, connectionId))
                .for("update");
              if (
                !locked ||
                locked.status !== "active" ||
                locked.accountEpoch !== connection.accountEpoch ||
                locked.credentialRevision !== plan.credentialRevision
              )
                return {
                  kind: "failed",
                  message: "The sign-in changed while it was refreshed.",
                } satisfies RefreshResult;
              if (!outcome.ok) {
                yield* needsReauth(tx, connectionId);
                return { kind: "revoked" } satisfies RefreshResult;
              }
              const next: StoredCredentials = {
                kind: "oauth",
                accessToken: outcome.tokens.accessToken,
                // Services that do not rotate send no new refresh token.
                refreshToken: outcome.tokens.refreshToken ?? plan.refreshToken,
                expiresAt: outcome.tokens.expiresAt,
                ...(plan.discovered ? { server: plan.discovered } : {}),
              };
              const credentialRevision = uuidv7();
              yield* tx
                .update(integrationConnections)
                .set({
                  credentialsCiphertext: yield* repo.encrypt(next),
                  credentialRevision,
                  updatedAt: new Date(),
                })
                .where(eq(integrationConnections.id, connectionId));
              const [config] = yield* tx
                .select()
                .from(integrationConfigs)
                .where(
                  and(
                    eq(integrationConfigs.id, row.id),
                    eq(integrationConfigs.enabled, true),
                    integrationUsableBy(connection.userId),
                  ),
                );
              if (
                !config ||
                configIdentity(config, adapter) !== configIdentity(row, adapter) ||
                config.revision !== setup.revision ||
                locked.configFingerprint !== setup.fingerprint
              )
                return { kind: "failed", message: UNAVAILABLE } satisfies RefreshResult;
              return {
                kind: "credential",
                credential: {
                  kind: "oauth",
                  accessToken: next.accessToken,
                  identity: { ...credentialIdentity(locked), credentialRevision },
                },
              } satisfies RefreshResult;
            }),
          )
          .pipe(Effect.orDie);
        return result as RefreshResult;
      }).pipe(refreshTurn(connection.id));

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
        if (
          !current ||
          current.status !== "active" ||
          current.accountEpoch !== connection.accountEpoch
        )
          return yield* new IntegrationRequestFailed({
            status: null,
            message: "This integration is no longer connected.",
          });
        const enabled = yield* available(connection.userId, row.id).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (
          !enabled ||
          enabled.fingerprint !== setup.fingerprint ||
          enabled.row.revision !== setup.revision ||
          current.configFingerprint !== setup.fingerprint ||
          current.configFingerprint !== connection.configFingerprint ||
          configIdentity(enabled.row, adapter) !== configIdentity(row, adapter) ||
          !wayOpen(enabled.manifest, adapter, enabled.row, enabled.config, current.authKind)
        )
          return yield* new IntegrationRequestFailed({ status: null, message: UNAVAILABLE });
        const identity = credentialIdentity(current);
        // The admin's key, read fresh: replacing it applies to the next call.
        if (current.authKind === "shared") {
          const shared = yield* repo.sharedCredential(enabled.row);
          if (!shared)
            return yield* new IntegrationAuthFailed({
              integrationId: row.id,
              credential: identity,
            });
          return { kind: "api_key", values: shared, identity };
        }
        const stored = yield* repo.decrypt(current);
        if (stored?.kind === "none") return { kind: "none", identity };
        if (stored?.kind === "api_key") return { kind: "api_key", values: stored.values, identity };
        if (
          stored &&
          (stored.expiresAt === null || stored.expiresAt - REFRESH_MARGIN_MS > Date.now())
        )
          return {
            kind: "oauth",
            accessToken: stored.accessToken,
            identity: credentialIdentity(current),
          };
        // Expired or unreadable: refreshing decides under the row lock.
        const result = yield* refresh(connection, row, adapter, setup);
        if (result.kind === "credential") return result.credential;
        if (result.kind === "revoked") {
          yield* changed(connection.userId);
          return yield* new IntegrationAuthFailed({ integrationId: row.id });
        }
        return yield* new IntegrationRequestFailed({ status: null, message: result.message });
      });

    /** A working session as one of this person's accounts, with the row it was made from. */
    const openSession = Effect.fn("IntegrationService.session")(function* (
      userId: string,
      connectionId: string,
    ) {
      const connection = yield* repo.getConnection(userId, connectionId);
      // A connection that is not theirs reads like one that is gone.
      if (!connection)
        return yield* new IntegrationNotAvailable({ integrationId: null, connectionId });
      const integrationId = connection.integrationId;
      const stored = yield* repo.getConfig(integrationId);
      const state = stored
        ? accountUsability(stored, yield* repo.isUsable(userId, integrationId), connection)
        : null;
      if (!state?.usable) return yield* new IntegrationNotAvailable({ integrationId });
      const { manifest, adapter, row, config, fingerprint } = state;
      const session: ConnectedSession = {
        connectionId: connection.id,
        accountEpoch: connection.accountEpoch,
        configIdentity: configIdentity(row, adapter)!,
        integration: { id: row.id, kind: row.kind, name: row.name },
        adapter,
        tools: yield* toolsOf(manifest, adapter, row, connection),
        authKind: connection.authKind,
        account: accountName(connection),
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
      return { session, connection };
    });

    const sessionFor = (userId: string, connectionId: string) =>
      openSession(userId, connectionId).pipe(Effect.map(({ session }) => session));

    /**
     * Reconnecting an account must sign in as that same account: another one
     * under its row would quietly move its chats and grants to someone else.
     */
    const sameAccount = Effect.fn(function* (
      userId: string,
      integrationId: string,
      connectionId: string | null,
      accountKey: string | null,
    ) {
      if (!connectionId) return;
      const current = yield* repo.getConnection(userId, connectionId);
      if (current?.integrationId !== integrationId)
        return yield* new IntegrationNotAvailable({ integrationId, connectionId });
      if (current.accountKey && accountKey && current.accountKey !== accountKey)
        return yield* new IntegrationRejected({
          reason: `That is another account than “${accountName(current)}”. Add it as another account instead.`,
        });
      // A row from before it knew its account cannot take on one connected beside it.
      const listed = yield* repo.listForUser(userId, integrationId);
      const other = listed
        .find((entry) => entry.config.id === integrationId)
        ?.connections.find((entry) => entry.id !== connectionId && entry.accountKey === accountKey);
      if (accountKey && other)
        return yield* new IntegrationRejected({
          reason: `That account is already connected as “${accountName(other)}”.`,
        });
    });

    return { available, discoveredSecret, openSession, sessionFor, sameAccount };
  });
