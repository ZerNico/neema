import { Context, Effect, Layer } from "effect";
import { conversations } from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegrationType } from "../catalog.ts";
import { IntegrationAuthFailed, IntegrationNotAvailable, IntegrationRejected } from "../errors.ts";
import type { ToolPermission, UnattendedGrant } from "../consent.ts";
import type { IntegrationGrant } from "../grant.ts";
import type { AdminCatalog, AdminIntegration, ScopeOption, UserIntegration } from "../schema.ts";
import { readFields } from "../fields.ts";
import type { IntegrationManifest } from "../manifest.ts";
import type { CatalogDecision, IntegrationAdapter } from "./adapter.ts";
import { findAdapterType } from "./adapters.ts";
import { shippedTools } from "./tools.ts";
import {
  IntegrationRepo,
  type IntegrationConfigRow,
  type IntegrationConnectionRow,
  type SaveConfig,
} from "./repo.ts";
import {
  makeCredentials,
  methodsFor,
  verified,
  wayOpen,
  type ConnectedSession,
} from "./credentials.ts";
import { makeOAuthFlow } from "./oauth-flow.ts";
import { makeCatalogService, toCatalog } from "./catalog-service.ts";

const connectOutdated = () =>
  new IntegrationRejected({
    reason: "This integration’s setup changed while connecting. Try again.",
  });

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

/** At most this many items in one connection's limit. */
const MAX_SCOPE_ITEMS = 200;

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
    reportAuthFailure(input: {
      userId: string;
      failure: IntegrationAuthFailed;
    }): Effect.Effect<void>;
    /** Records scopes a call lacked, so Settings offers to grant them. */
    reportMissingScopes(
      connection: { userId: string; connectionId: string; accountEpoch: string },
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

      const credentials = yield* makeCredentials({ toolsOf, changed });
      const { available, sessionFor } = credentials;
      const oauth = yield* makeOAuthFlow({ credentials, changed });
      const catalog = yield* makeCatalogService({ credentials });

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
          const manifest = findIntegrationType(row.config.kind);
          if (
            !manifest ||
            !wayOpen(manifest, adapter, row.config, normalized.config, row.connection.authKind)
          )
            continue;
          usable.set(row.config.id, { connection: row.connection, config: row.config });
        }
        return usable;
      });

      const chatIntegrations = Effect.fn("IntegrationService.chatIntegrations")(function* (
        userId: string,
        conversationId: string | null,
      ) {
        const usable = yield* usableConnections(userId);
        // Another person's chat reads as no chat: its toggles and agent are theirs.
        const [owned] = conversationId
          ? yield* db
              .select({ id: conversations.id })
              .from(conversations)
              .where(ownedConversationById(conversationId, userId))
              .pipe(Effect.orDie)
          : [];
        const chatId = owned?.id ?? null;
        const settings = chatId ? yield* repo.conversationSettings(chatId) : [];
        const attached = chatId ? yield* repo.agentIntegrationIds(chatId) : null;
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
            const readsOnly = connection
              ? connection.authKind === "shared"
              : methods.open === "shared" && !methods.oauth && !methods.apiKey;
            const stale =
              connection !== null &&
              configured &&
              (connection.configFingerprint !== normalized.fingerprint ||
                !wayOpen(manifest, adapter, entry.config, normalized.config, connection.authKind));
            result.push({
              id: entry.config.id,
              kind: entry.config.kind,
              name: entry.config.name,
              available: open,
              methods,
              // A shared key only ever reads, so its other tools are not anyone's to set.
              tools: (yield* toolsOf(manifest, adapter, entry.config.id))
                .filter((tool) => !readsOnly || tool.access === "read")
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
            const saved = yield* repo.saveConnection({
              userId,
              integrationId,
              revision: row.revision,
              authKind: "api_key",
              credentials: { kind: "api_key", values },
              accountLabel,
              fingerprint,
            });
            if (!saved) return yield* connectOutdated();
            yield* changed(userId);
          },
        ),

        checkCatalog: (integrationId, asUserId) => catalog.checkCatalog(integrationId, asUserId),
        approveCatalog: catalog.approveCatalog,
        checkDueCatalogs: catalog.checkDueCatalogs,

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
          const verifiedOpen = yield* verified(
            adapter,
            config,
            shared ? { kind: "api_key", values: shared } : { kind: "none" },
          );
          const saved = yield* repo.saveConnection({
            userId,
            integrationId,
            revision: row.revision,
            authKind: open,
            credentials: { kind: "none" },
            accountLabel: shared ? "Shared key" : verifiedOpen.accountLabel,
            fingerprint,
          });
          if (!saved) return yield* connectOutdated();
          yield* changed(userId);
        }),

        beginOAuth: oauth.beginOAuth,
        completeOAuth: oauth.completeOAuth,

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
          if (!input.failure.credential) return;
          yield* repo.markNeedsReauth(input.failure.credential);
          yield* changed(input.userId);
        }),

        reportMissingScopes: Effect.fn("IntegrationService.reportMissingScopes")(
          function* (input, scopes) {
            const words = scopes.filter((scope) => /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/.test(scope));
            if (words.length === 0) return;
            yield* repo.addRequiredScopes(input, words);
            yield* changed(input.userId);
          },
        ),
      });
    }),
  );
}
