import { Context, Effect, Layer } from "effect";
import { conversations } from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { findIntegrationType } from "../catalog.ts";
import { IntegrationAuthFailed, IntegrationNotAvailable, IntegrationRejected } from "../errors.ts";
import type { ToolPermission, UnattendedGrant } from "../consent.ts";
import type { IntegrationGrant } from "../grant.ts";
import {
  accountName,
  usesNoAccount,
  PERSONAL_SERVER_FIELDS,
  type AdminIntegration,
  type AdminTool,
  type IntegrationConnectionView,
  type PersonalServer,
  type PersonalServers,
  type IntegrationDirectoryEntry,
  type ListingSummary,
  type ScopeOption,
  type UserIntegration,
} from "../schema.ts";
import {
  knownMcpServerAt,
  knownMcpServerWithUrl,
  findKnownMcpServer,
} from "../mcp/known-servers.ts";
import type { McpToolEntry } from "../mcp/catalog.ts";
import { MCP_LIMITS } from "../mcp/catalog.ts";
import { resolvePublicHttpUrl } from "~/modules/tools/server/url-safety.ts";
import { mcpWaysOf } from "../mcp/manifest.ts";
import { fieldValues, readFields } from "../fields.ts";
import type { IntegrationManifest, IntegrationToolInfo, ToolAccess } from "../manifest.ts";
import type { IntegrationAdapter, OfferedTool } from "./adapter.ts";
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
  probe,
  verified,
  wayOpen,
  type ConnectedSession,
} from "./credentials.ts";
import { makeOAuthFlow } from "./oauth-flow.ts";
import { offersSignIn } from "../mcp/server/auth.ts";
import { listingOwner, makeToolListings, toListingView } from "./tool-listings.ts";

const connectOutdated = () =>
  new IntegrationRejected({
    reason: "This integration’s setup changed while connecting. Try again.",
  });

/** One account as a chat sees it: whether it is on here, and how much it asks. */
export interface ChatIntegration {
  connectionId: string;
  integrationId: string;
  kind: string;
  name: string;
  /** What the person calls the account; null when there is none (open, or the admin's key). */
  account: string | null;
  enabled: boolean;
  /** What `enabled` would be without this chat's own choice. */
  defaultEnabled: boolean;
}

export interface ResolvedOffer {
  connectionId: string;
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

/** The known MCP server an integration points at, read from its address each time. */
const knownServer = (row: { kind: string; config: Readonly<Record<string, string>> }) =>
  row.kind === "mcp" ? (knownMcpServerAt(row.config.url)?.id ?? null) : null;

const toAdmin = (
  row: IntegrationConfigRow & { connectionCount: number },
  tools: ReadonlyArray<AdminTool>,
  listings: ListingSummary | null,
): AdminIntegration => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  description: row.description,
  server: knownServer(row),
  enabled: row.enabled,
  config: row.config,
  oauthClientId: row.oauthClientId,
  oauthSecretConfigured: Boolean(row.oauthClientSecretCiphertext),
  allowApiKeys: row.allowApiKeys,
  audience: row.audience,
  connectionCount: row.connectionCount,
  sharedCredentialConfigured: Boolean(row.sharedCredentialCiphertext),
  tools,
  listings,
});

const NAME_MAX = 60;
const DESCRIPTION_MAX = 160;
/** How long a server left half added waits for its owner; a sign-in lives ten minutes. */
const DRAFT_TTL_MS = 60 * 60_000;

const byName = <A extends { name: string }>(a: A, b: A) => a.name.localeCompare(b.name);

/** At most this many items in one connection's limit. */
const MAX_SCOPE_ITEMS = 200;

/** At most this many MCP servers of one's own. */
const MAX_PERSONAL_SERVERS = 20;

const unknownIntegration = () => new IntegrationRejected({ reason: "Unknown integration." });

export class IntegrationService extends Context.Service<
  IntegrationService,
  {
    adminList(): Effect.Effect<ReadonlyArray<AdminIntegration>>;
    /** Every integration this person could meet a reference to: the admin's and their own. */
    directory(userId: string): Effect.Effect<ReadonlyArray<IntegrationDirectoryEntry>>;
    personalServers(userId: string): Effect.Effect<PersonalServers>;
    /** Adds or changes a server of one's own; its address must be public. */
    savePersonalServer(
      userId: string,
      input: {
        integrationId: string | null;
        name: string;
        config: Readonly<Record<string, string>>;
      },
    ): Effect.Effect<PersonalServer, IntegrationRejected>;
    deletePersonalServer(
      userId: string,
      integrationId: string,
    ): Effect.Effect<void, IntegrationRejected>;
    /**
     * How a person reaches a server at an address, found by asking it: open to
     * anyone, signing in, or a token from their account there. Nothing is saved.
     */
    probeServer(
      userId: string,
      url: string,
    ): Effect.Effect<{ ways: "anonymous" | "oauth" | "token"; name: string }, IntegrationRejected>;
    /** A server of one's own being added, as connecting it needs it. */
    serverSetup(
      userId: string,
      integrationId: string,
    ): Effect.Effect<UserIntegration, IntegrationRejected>;
    /** Lists a server being added once an account of its owner's connected. */
    finishServerSetup(
      userId: string,
      integrationId: string,
    ): Effect.Effect<void, IntegrationRejected>;
    /** Deletes servers left half added; the listing sweep calls this. */
    sweepDrafts(): Effect.Effect<void>;
    /** Lists what a server offers this person's own accounts on it again, now. */
    checkOwnTools(userId: string, integrationId: string): Effect.Effect<void, IntegrationRejected>;
    /** A new integration of a shipped type, off until set up. */
    /** Adds an integration of a type; the server picks its id. */
    createIntegration(input: {
      kind: string;
      name: string;
      /** A known MCP server: added on, at its address, with its sign-in. */
      server?: string;
    }): Effect.Effect<AdminIntegration, IntegrationRejected>;
    deleteIntegration(id: string): Effect.Effect<void, IntegrationRejected>;
    saveConfig(
      input: Omit<SaveConfig, "fingerprint" | "listsTools">,
    ): Effect.Effect<AdminIntegration, IntegrationRejected>;
    /** With `draftId`, also this person's server of that id still being added. */
    listForUser(userId: string, draftId?: string): Effect.Effect<ReadonlyArray<UserIntegration>>;
    /** Adds an account by key, or with `connectionId` replaces that account's key. */
    connectApiKey(
      userId: string,
      integrationId: string,
      /** The manifest's API key fields as typed; undeclared keys are dropped. */
      values: Readonly<Record<string, string>>,
      connectionId?: string,
    ): Effect.Effect<void, IntegrationNotAvailable | IntegrationRejected>;
    /** Starts a sign-in for another account, or with `connectionId` to reconnect that one. */
    beginOAuth(
      userId: string,
      integrationId: string,
      origin: string,
      returnTo?: string,
      connectionId?: string,
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
     * Lists a catalog type's tools from its server now: without an account
     * when it allows that, and with the admin's own accounts on it.
     */
    checkTools(adminId: string, integrationId: string): Effect.Effect<void, IntegrationRejected>;
    /** The admin's word on one tool for everyone; nothing about it is a new revision. */
    setTool(
      integrationId: string,
      tool: string,
      setting: { off: boolean; access: ToolAccess | null },
    ): Effect.Effect<AdminIntegration, IntegrationRejected>;
    /** Listings due now, claimed under a lease; the sweep calls this. */
    checkDueListings(): Effect.Effect<void>;
    updatePreferences(
      userId: string,
      connectionId: string,
      input: Parameters<IntegrationRepo["Service"]["updatePreferences"]>[2],
    ): Effect.Effect<void, IntegrationNotAvailable | IntegrationRejected>;
    /** What an account can be limited to, from the service as that account sees it. */
    scopeOptions(
      userId: string,
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<ScopeOption>, IntegrationNotAvailable | IntegrationRejected>;
    disconnect(userId: string, connectionId: string): Effect.Effect<void>;
    /**
     * A working session as one of this person's accounts, or
     * `IntegrationNotAvailable` when the integration is off or unshared, or the
     * account is gone, not theirs, or waiting for reconnect.
     */
    session(
      userId: string,
      connectionId: string,
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
     * Usable accounts and whether this chat offers them: the chat's own
     * choice, else the agent's attachments (every account of an attached
     * integration), else the account's "turn on in new chats". A null
     * conversation is a chat not created yet.
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
      connectionId: string,
    ): Effect.Effect<CallPermissions>;
    setConversationIntegration(
      userId: string,
      conversationId: string,
      connectionId: string,
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

      /**
       * What one account is offered: a shipped type's tools, or what its server
       * lists to it (to nobody, for a way in without an account), with the
       * admin's word on each tool applied. Null `connection` is the preview
       * before connecting.
       */
      const toolsOf = Effect.fn(function* (
        manifest: IntegrationManifest,
        adapter: IntegrationAdapter,
        row: IntegrationConfigRow,
        connection: { id: string; authKind: IntegrationConnectionView["authKind"] } | null,
      ) {
        const settings = row.toolSettings;
        // With the admin's key a tool must only read by its own word as well: a
        // correction may narrow what that key does, never widen it.
        const sharedKey = connection?.authKind === "shared";
        const adjusted = <A extends { access: ToolAccess }>(name: string, tool: A): A | null => {
          const setting = settings[name];
          if (setting?.off) return null;
          const access = setting?.access ?? tool.access;
          if (sharedKey && (tool.access !== "read" || access !== "read")) return null;
          return access === tool.access ? tool : { ...tool, access };
        };
        if (manifest.toolSource === "static")
          return shippedTools(manifest, adapter).flatMap((tool) => adjusted(tool.name, tool) ?? []);
        const lister = adapter.listing;
        if (!lister) return [];
        const listing = yield* repo.toolListing(
          row.id,
          connection ? listingOwner(connection) : null,
        );
        return (listing?.tools ?? [])
          .flatMap((entry) => (entry.unsupported ? [] : (adjusted(entry.mcpName, entry) ?? [])))
          .flatMap((entry) => lister.tool(row.id, entry) ?? [])
          .slice(0, MCP_LIMITS.enabledTools);
      });

      /**
       * Every tool any account sees, once each by the name the admin's word is
       * kept under, in the order the newest listing gives, and how the checks
       * behind them went.
       */
      const adminTools = Effect.fn(function* (
        manifest: IntegrationManifest,
        adapter: IntegrationAdapter,
        row: IntegrationConfigRow,
      ) {
        const view = (
          name: string,
          tool: { title: string; description: string; access: ToolAccess },
          unsupported: string | null,
          pastLimit: boolean,
        ): AdminTool => {
          const setting = row.toolSettings[name];
          return {
            name,
            title: tool.title,
            description: tool.description,
            access: setting?.access ?? tool.access,
            claimed: tool.access,
            off: Boolean(setting?.off),
            unsupported,
            pastLimit,
          };
        };
        if (manifest.toolSource === "static")
          return {
            tools: shippedTools(manifest, adapter).map((tool) =>
              view(tool.name, tool, null, false),
            ),
            listings: null,
          };
        const listings = (yield* repo.toolListings(row.id)).toSorted(
          (a, b) => (b.checkedAt?.getTime() ?? 0) - (a.checkedAt?.getTime() ?? 0),
        );
        const seen = new Map<string, McpToolEntry>();
        // Past the limit in any account's listing, counted as `toolsOf` offers them.
        const pastLimit = new Set<string>();
        for (const listing of listings) {
          let offered = 0;
          for (const entry of listing.tools ?? []) {
            if (!seen.has(entry.mcpName)) seen.set(entry.mcpName, entry);
            if (entry.unsupported || row.toolSettings[entry.mcpName]?.off) continue;
            if (++offered > MCP_LIMITS.enabledTools) pastLimit.add(entry.mcpName);
          }
        }
        const failing = listings.filter((listing) => listing.checkError);
        return {
          tools: [...seen.values()].map((entry) =>
            view(entry.mcpName, entry, entry.unsupported ?? null, pastLimit.has(entry.mcpName)),
          ),
          listings: {
            checkedAt:
              listings.find((listing) => listing.checkedAt)?.checkedAt?.toISOString() ?? null,
            failing: failing.length,
            error: failing[0]?.checkError ?? null,
          } satisfies ListingSummary,
        };
      });

      const adminView = Effect.fn(function* (
        row: IntegrationConfigRow & { connectionCount: number },
      ) {
        const manifest = findIntegrationType(row.kind);
        const adapter = findAdapterType(row.kind);
        const { tools, listings } =
          manifest && adapter
            ? yield* adminTools(manifest, adapter, row)
            : { tools: [], listings: null };
        return toAdmin(row, tools, listings);
      });

      /** An admin's integration, never a person's own server. */
      const adminServer = Effect.fn(function* (integrationId: string) {
        const row = yield* repo.getConfig(integrationId);
        if (row && row.ownerUserId !== null) return yield* unknownIntegration();
      });

      const personalView = Effect.fn(function* (
        row: IntegrationConfigRow,
        rows: ReadonlyArray<{
          config: { id: string };
          connections: ReadonlyArray<IntegrationConnectionRow>;
        }>,
      ) {
        // Their own account's listing, else the one without an account.
        const accounts = rows.find((entry) => entry.config.id === row.id)?.connections;
        const own = accounts?.find((account) => listingOwner(account) !== null);
        return {
          id: row.id,
          name: row.name,
          config: Object.fromEntries(
            PERSONAL_SERVER_FIELDS.flatMap((key) =>
              row.config[key] === undefined ? [] : [[key, row.config[key]!]],
            ),
          ),
          listing: toListingView(yield* repo.toolListing(row.id, own?.id ?? null)),
        } satisfies PersonalServer;
      });

      const credentials = yield* makeCredentials({ toolsOf, changed });
      const { available, sessionFor } = credentials;
      const listings = yield* makeToolListings({ credentials });
      /** Lists each one, all of them even when one fails, then says what failed first. */
      const listEach = Effect.fn(function* (
        integrationId: string,
        owners: ReadonlySet<string | null>,
      ) {
        const outcomes = yield* Effect.forEach(owners, (owner) =>
          listings.listTools(integrationId, owner).pipe(Effect.result),
        );
        const failed = outcomes.find((outcome) => outcome._tag === "Failure");
        if (failed?._tag === "Failure") return yield* failed.failure;
      });
      const oauth = yield* makeOAuthFlow({
        credentials,
        changed,
        connected: listings.listForConnection,
      });

      /**
       * This person's integrations, after giving them a connection to each one
       * an admin turned on for everyone and they have no account on. Such a
       * connection holds nothing personal, so it is made on read, without
       * asking the server, and an earlier one is pointed at the current setup.
       */
      const listWithEveryone = Effect.fn(function* (userId: string, draftId?: string) {
        const rows = yield* repo.listForUser(userId, draftId);
        let added = false;
        for (const row of rows) {
          const manifest = findIntegrationType(row.config.kind);
          const adapter = findAdapterType(row.config.kind);
          if (!manifest || !adapter || !row.config.enabled || !row.usable) continue;
          const normalized = adapter.normalizeConfig(row.config.config);
          if ("error" in normalized) continue;
          const { open, everyone } = methodsFor(
            manifest,
            adapter,
            row.config,
            normalized.config,
            Boolean(row.config.sharedCredentialCiphertext),
          );
          if (!everyone || !open) continue;
          // An account of their own takes over; the open one is only for those without.
          if (row.connections.some((existing) => !usesNoAccount(existing.authKind))) continue;
          const current = row.connections[0];
          if (
            current &&
            current.authKind === open &&
            current.configFingerprint === normalized.fingerprint
          )
            continue;
          const saved = yield* repo.saveConnection({
            userId,
            integrationId: row.config.id,
            revision: row.config.revision,
            authKind: open,
            credentials: { kind: "none" },
            accountLabel: open === "shared" ? "Shared key" : row.config.name,
            accountKey: null,
            fingerprint: normalized.fingerprint,
          });
          if (!saved) continue;
          added = true;
          // Only ever the first time: once the shared listing exists, the sweep keeps it.
          yield* listings.listForConnection(saved);
        }
        return added ? yield* repo.listForUser(userId, draftId) : rows;
      });

      /** Accounts that work right now, by integration then age. */
      const usableConnections = Effect.fn(function* (userId: string) {
        const rows = yield* listWithEveryone(userId);
        const usable: Array<{
          connection: IntegrationConnectionRow;
          config: IntegrationConfigRow;
        }> = [];
        for (const row of rows.toSorted((a, b) => byName(a.config, b.config))) {
          const adapter = findAdapterType(row.config.kind);
          const manifest = findIntegrationType(row.config.kind);
          if (!adapter || !manifest || !row.config.enabled || !row.usable) continue;
          const normalized = adapter.normalizeConfig(row.config.config);
          if ("error" in normalized) continue;
          for (const connection of row.connections) {
            if (connection.status !== "active") continue;
            if (connection.configFingerprint !== normalized.fingerprint) continue;
            if (!wayOpen(manifest, adapter, row.config, normalized.config, connection.authKind))
              continue;
            usable.push({ connection, config: row.config });
          }
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
        return usable.map(({ connection, config }): ChatIntegration => {
          const own = settings.find((entry) => entry.connectionId === connection.id);
          // An agent names an integration, not anyone's account: all of theirs come with it.
          const defaultEnabled = attached
            ? attached.includes(config.id)
            : connection.offerByDefault;
          return {
            connectionId: connection.id,
            integrationId: config.id,
            kind: config.kind,
            name: config.name,
            account: usesNoAccount(connection.authKind) ? null : accountName(connection),
            enabled: own?.enabled ?? defaultEnabled,
            defaultEnabled,
          };
        });
      });

      const listForUser = Effect.fn("IntegrationService.listForUser")(function* (
        userId: string,
        draftId?: string,
      ) {
        const rows = yield* listWithEveryone(userId, draftId);
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
          if (!open && entry.connections.length === 0) continue;
          // The admin's key only ever reads, and stands alone: an own account replaces it.
          const readsOnly = entry.connections.length
            ? entry.connections.every((connection) => connection.authKind === "shared")
            : methods.open === "shared" && !methods.oauth && !methods.apiKey;
          const stale = (connection: IntegrationConnectionRow) =>
            configured &&
            (connection.configFingerprint !== normalized.fingerprint ||
              !wayOpen(manifest, adapter, entry.config, normalized.config, connection.authKind));
          // A shared key only ever reads, so its other tools are not anyone's to set.
          const toolInfo = (tools: ReadonlyArray<OfferedTool>): IntegrationToolInfo[] =>
            tools
              .filter((tool) => !readsOnly || tool.access === "read")
              .map((tool) => ({
                name: tool.name,
                title: tool.title,
                label: tool.label,
                description: tool.description,
                access: tool.access,
              }));
          result.push({
            id: entry.config.id,
            kind: entry.config.kind,
            name: entry.config.name,
            description: entry.config.description,
            server: knownServer(entry.config),
            available: open,
            personal: entry.config.ownerUserId !== null,
            methods,
            tools: toolInfo(yield* toolsOf(manifest, adapter, entry.config, null)),
            apiKeyHelpUrl: configured
              ? (manifest.apiKey?.helpUrl(normalized.config) ?? null)
              : null,
            connections: yield* Effect.forEach(entry.connections, (connection) =>
              Effect.all({
                dependents: repo.dependents(userId, connection.id),
                tools: toolsOf(manifest, adapter, entry.config, connection),
                listing:
                  manifest.toolSource === "listed"
                    ? repo.toolListing(entry.config.id, listingOwner(connection))
                    : Effect.succeed(null),
              }).pipe(
                Effect.map(({ dependents, tools, listing }): IntegrationConnectionView => ({
                  id: connection.id,
                  authKind: connection.authKind,
                  accountLabel: connection.accountLabel,
                  name: connection.name,
                  status: stale(connection) ? "needs_reauth" : connection.status,
                  offerByDefault: connection.offerByDefault,
                  toolPermissions: connection.toolPermissions,
                  scope: connection.scope,
                  requiredScopes: connection.requiredScopes,
                  listing: toListingView(listing),
                  tools: toolInfo(tools),
                  dependents,
                  createdAt: connection.createdAt.toISOString(),
                })),
              ),
            ),
          });
        }
        return result;
      });

      return IntegrationService.of({
        chatIntegrations,
        reserveAllowance: repo.reserveAllowance,
        releaseAllowance: repo.releaseAllowance,

        resolveOffer: Effect.fn("IntegrationService.resolveOffer")(function* (input) {
          const chosen: Array<{ connectionId: string; unattended: UnattendedGrant }> = input.grants
            ? input.grants.map((grant) => ({
                connectionId: grant.connectionId,
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
                .map((entry) => ({ connectionId: entry.connectionId, unattended: null }));
          const offers: ResolvedOffer[] = [];
          for (const entry of chosen) {
            // An account gone since the turn was accepted drops out of the
            // offer, like a disabled custom tool, rather than failing it.
            const session = yield* sessionFor(input.userId, entry.connectionId).pipe(Effect.option);
            if (session._tag === "Some") {
              const connection = yield* repo.getConnection(input.userId, entry.connectionId);
              offers.push({
                connectionId: entry.connectionId,
                integrationId: session.value.integration.id,
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
          function* (userId, conversationId, connectionId) {
            const settings = yield* repo.conversationSettings(conversationId);
            const own = settings.find((entry) => entry.connectionId === connectionId);
            const connection = yield* repo.getConnection(userId, connectionId);
            return {
              permissions: connection?.toolPermissions ?? {},
              allowedInChat: own?.allowedTools ?? [],
            };
          },
        ),

        setConversationIntegration: Effect.fn("IntegrationService.setConversationIntegration")(
          function* (userId, conversationId, connectionId, input) {
            const saved = yield* repo.setConversationSetting(
              userId,
              conversationId,
              connectionId,
              input,
            );
            if (!saved)
              return yield* new IntegrationNotAvailable({ integrationId: null, connectionId });
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

        directory: Effect.fn("IntegrationService.directory")(function* (userId) {
          const rows = [...(yield* repo.listConfigs()), ...(yield* repo.listConfigs(userId))];
          return rows.toSorted(byName).map((row) => ({
            id: row.id,
            kind: row.kind,
            name: row.name,
            description: row.description,
            server: knownServer(row),
          }));
        }),

        personalServers: Effect.fn("IntegrationService.personalServers")(function* (userId) {
          const rows = yield* repo.listConfigs(userId);
          const listed = yield* repo.listForUser(userId);
          return {
            canAdd: yield* repo.mayAddServers(userId),
            servers: yield* Effect.forEach(rows.toSorted(byName), (row) =>
              personalView(row, listed),
            ),
          };
        }),

        savePersonalServer: Effect.fn("IntegrationService.savePersonalServer")(
          function* (userId, input) {
            if (!(yield* repo.mayAddServers(userId)))
              return yield* new IntegrationRejected({
                reason: "Your admin has not let you add MCP servers.",
              });
            const adapter = findAdapterType("mcp");
            if (!adapter) return yield* unknownIntegration();
            const stored = input.integrationId ? yield* repo.getConfig(input.integrationId) : null;
            if (input.integrationId && stored?.ownerUserId !== userId)
              return yield* unknownIntegration();
            if (!stored && (yield* repo.listConfigs(userId)).length >= MAX_PERSONAL_SERVERS)
              return yield* new IntegrationRejected({
                reason: `You can add at most ${MAX_PERSONAL_SERVERS} servers.`,
              });
            const name = input.name.trim();
            if (!name || name.length > NAME_MAX)
              return yield* new IntegrationRejected({ reason: "Give it a name." });
            if (yield* repo.nameTaken(name, stored?.id ?? null, userId))
              return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
            // Only what a person may choose; without an account means open, never a shared key.
            const config: Record<string, string> = Object.fromEntries(
              PERSONAL_SERVER_FIELDS.flatMap((key) =>
                input.config[key] === undefined ? [] : [[key, input.config[key]]],
              ),
            );
            if (fieldValues(config.ways).includes("anonymous")) config.anonymous = "open";
            config.reach = "public";
            const normalized = adapter.normalizeConfig(config);
            if ("error" in normalized)
              return yield* new IntegrationRejected({ reason: normalized.error });
            // Each request checks this again; asking now just says so before anything is saved.
            yield* resolvePublicHttpUrl(normalized.config.url!).pipe(
              Effect.mapError(
                () =>
                  new IntegrationRejected({
                    reason: "Use a public address. An admin can add servers on a private network.",
                  }),
              ),
            );
            // One added at a time: a server left half added makes way, name and all.
            if (!stored) yield* repo.sweepDrafts({ ownerUserId: userId });
            const opens = mcpWaysOf(normalized.config).anonymous === "open";
            // Open, it is done once saved; anything else waits for its first account.
            const id =
              stored?.id ??
              (yield* repo.createConfig({ kind: "mcp", name, ownerUserId: userId, draft: !opens }));
            if (!id)
              return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
            const row = yield* repo.saveConfig({
              id,
              name,
              enabled: true,
              config: normalized.config,
              fingerprint: normalized.fingerprint,
              oauthClientId: null,
              allowApiKeys: true,
              listsTools: true,
            });
            if (!row) return yield* unknownIntegration();
            // Needing no account, it is on for its owner once saved, as connecting would
            // make it; their own token or sign-in, if any, stays.
            const accounts =
              (yield* repo.listForUser(userId, id)).find((entry) => entry.config.id === id)
                ?.connections ?? [];
            const opened =
              mcpWaysOf(normalized.config).anonymous === "open" &&
              accounts.every((account) => usesNoAccount(account.authKind))
                ? yield* repo.saveConnection({
                    userId,
                    integrationId: id,
                    revision: row.revision,
                    authKind: "none",
                    credentials: { kind: "none" },
                    accountLabel: name,
                    accountKey: null,
                    fingerprint: normalized.fingerprint,
                  })
                : null;
            if (opened) yield* listings.listForConnection(opened);
            yield* changed(userId);
            return yield* personalView(row, yield* repo.listForUser(userId, row.id));
          },
        ),

        deletePersonalServer: Effect.fn("IntegrationService.deletePersonalServer")(
          function* (userId, integrationId) {
            const row = yield* repo.getConfig(integrationId);
            if (row?.ownerUserId !== userId) return yield* unknownIntegration();
            yield* repo.deleteConfig(integrationId);
            yield* changed(userId);
          },
        ),

        probeServer: Effect.fn("IntegrationService.probeServer")(function* (userId, url) {
          if (!(yield* repo.mayAddServers(userId)))
            return yield* new IntegrationRejected({
              reason: "Your admin has not let you add MCP servers.",
            });
          const adapter = findAdapterType("mcp");
          if (!adapter) return yield* unknownIntegration();
          const normalized = adapter.normalizeConfig({
            url: url.trim(),
            ways: "anonymous",
            anonymous: "open",
            reach: "public",
          });
          if ("error" in normalized)
            return yield* new IntegrationRejected({ reason: normalized.error });
          yield* resolvePublicHttpUrl(normalized.config.url!).pipe(
            Effect.mapError(
              () =>
                new IntegrationRejected({
                  reason: "Use a public address. An admin can add servers on a private network.",
                }),
            ),
          );
          const address = new URL(normalized.config.url!);
          const name =
            knownMcpServerWithUrl(normalized.config.url)?.name ??
            address.hostname.replace(/^(mcp|api)\./, "");
          // Asked as nobody, as anyone may: a refusal says it wants an account.
          const asNobody = yield* adapter
            .verify(probe(normalized.config, { kind: "none" }))
            .pipe(Effect.result);
          if (asNobody._tag === "Success") return { ways: "anonymous" as const, name };
          if (asNobody.failure._tag !== "IntegrationAuthFailed")
            return yield* new IntegrationRejected({
              reason:
                "message" in asNobody.failure && typeof asNobody.failure.message === "string"
                  ? asNobody.failure.message
                  : "Could not reach the server.",
            });
          const signIn = yield* offersSignIn(normalized.config);
          return { ways: signIn ? ("oauth" as const) : ("token" as const), name };
        }),

        serverSetup: Effect.fn("IntegrationService.serverSetup")(function* (userId, integrationId) {
          const row = yield* repo.getConfig(integrationId);
          if (row?.ownerUserId !== userId) return yield* unknownIntegration();
          const integration = (yield* listForUser(userId, integrationId)).find(
            (entry) => entry.id === integrationId,
          );
          if (!integration) return yield* unknownIntegration();
          return integration;
        }),

        finishServerSetup: Effect.fn("IntegrationService.finishServerSetup")(
          function* (userId, integrationId) {
            const entry = (yield* repo.listForUser(userId, integrationId)).find(
              (row) => row.config.id === integrationId,
            );
            if (entry?.config.ownerUserId !== userId) return yield* unknownIntegration();
            if (entry.connections.length === 0)
              return yield* new IntegrationRejected({ reason: "Connect it first." });
            yield* repo.publishDraft(userId, integrationId);
            yield* changed(userId);
          },
        ),

        sweepDrafts: Effect.fn("IntegrationService.sweepDrafts")(function* () {
          yield* repo.sweepDrafts({ olderThanMs: DRAFT_TTL_MS });
        }),

        checkOwnTools: Effect.fn("IntegrationService.checkOwnTools")(
          function* (userId, integrationId) {
            const entry = (yield* repo.listForUser(userId, integrationId)).find(
              (row) => row.config.id === integrationId,
            );
            if (!entry?.usable) return yield* unknownIntegration();
            const accounts = entry.connections.filter((account) => account.status === "active");
            if (accounts.length === 0)
              return yield* new IntegrationRejected({ reason: "Connect it first." });
            yield* listEach(integrationId, new Set(accounts.map(listingOwner)));
            yield* changed(userId);
          },
        ),

        createIntegration: Effect.fn("IntegrationService.createIntegration")(function* (input) {
          const adapter = findAdapterType(input.kind);
          if (!findIntegrationType(input.kind) || !adapter)
            return yield* new IntegrationRejected({ reason: "Unknown integration type." });
          const known = input.server === undefined ? null : findKnownMcpServer(input.server);
          if (input.server !== undefined && (!known || input.kind !== "mcp"))
            return yield* new IntegrationRejected({ reason: "Unknown MCP server." });
          const name = input.name.trim();
          if (!name || name.length > NAME_MAX)
            return yield* new IntegrationRejected({ reason: "Give it a name." });
          if (yield* repo.nameTaken(name, null, null))
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          const id = yield* repo.createConfig({ kind: input.kind, name });
          if (!id)
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          // A known server needs nothing more: on at once, at its address, people signing in.
          if (known) {
            const normalized = adapter.normalizeConfig({ url: known.url, ways: "oauth" });
            if ("error" in normalized) return yield* unknownIntegration();
            yield* repo.saveConfig({
              id,
              name,
              enabled: true,
              config: normalized.config,
              fingerprint: normalized.fingerprint,
              oauthClientId: null,
              allowApiKeys: true,
              listsTools: true,
            });
          }
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
          // A person's own server is theirs to set up, through savePersonalServer.
          if (!stored || !manifest || !adapter || stored.ownerUserId !== null)
            return yield* unknownIntegration();
          const name = input.name.trim();
          if (!name || name.length > NAME_MAX)
            return yield* new IntegrationRejected({ reason: "Give it a name." });
          if (yield* repo.nameTaken(name, input.id, null))
            return yield* new IntegrationRejected({ reason: `“${name}” is already in use.` });
          const description = input.description?.trim().replace(/\s+/g, " ");
          if (description && description.length > DESCRIPTION_MAX)
            return yield* new IntegrationRejected({
              reason: `Keep the description under ${DESCRIPTION_MAX} characters.`,
            });
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
          // Another server drops what the last one listed.
          const row = yield* repo.saveConfig({
            ...input,
            name,
            ...(description === undefined ? {} : { description: description || null }),
            oauthClientId: clientId,
            config: normalized.config,
            fingerprint: normalized.fingerprint,
            sharedCredential,
            listsTools: manifest.toolSource === "listed",
          });
          if (!row) return yield* new IntegrationRejected({ reason: "Unknown integration." });
          // Reachable without an account: what it lists shows at once, not after the first person.
          // Closed to that, the listing for nobody could only fail from then on.
          if (manifest.toolSource === "listed" && methods.open === null)
            yield* repo.deleteToolListing(row.id, null);
          else if (row.enabled && manifest.toolSource === "listed")
            yield* listings.listTools(row.id, null).pipe(Effect.ignore);
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
          const counted = (yield* repo.listConfigs()).find((entry) => entry.id === row.id);
          return yield* adminView(counted!);
        }),

        listForUser,
        connectApiKey: Effect.fn("IntegrationService.connectApiKey")(
          function* (userId, integrationId, input, connectionId) {
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
            const { accountLabel, accountKey } = yield* verified(adapter, config, {
              kind: "api_key",
              values,
            });
            yield* credentials.sameAccount(userId, integrationId, connectionId ?? null, accountKey);
            const saved = yield* repo.saveConnection({
              userId,
              integrationId,
              revision: row.revision,
              authKind: "api_key",
              credentials: { kind: "api_key", values },
              accountLabel,
              accountKey,
              fingerprint,
              connectionId: connectionId ?? null,
            });
            if (!saved) return yield* connectOutdated();
            yield* listings.listForConnection(saved);
            yield* changed(userId);
          },
        ),

        checkTools: Effect.fn("IntegrationService.checkTools")(function* (adminId, integrationId) {
          yield* adminServer(integrationId);
          const row = yield* repo.getConfig(integrationId);
          const manifest = row ? findIntegrationType(row.kind) : null;
          const adapter = row ? findAdapterType(row.kind) : null;
          if (!row || !manifest || !adapter || manifest.toolSource !== "listed")
            return yield* new IntegrationRejected({
              reason: "This integration does not list its own tools.",
            });
          const normalized = adapter.normalizeConfig(row.config);
          const methods = methodsFor(
            manifest,
            adapter,
            row,
            "error" in normalized ? {} : normalized.config,
            Boolean(row.sharedCredentialCiphertext),
          );
          // Without an account where it allows that, and as the admin's own accounts:
          // never anyone else's credential at an admin's request.
          const mine =
            (yield* repo.listForUser(adminId)).find((entry) => entry.config.id === integrationId)
              ?.connections ?? [];
          const owners = new Set<string | null>(mine.map(listingOwner));
          if (methods.open !== null) owners.add(null);
          if (owners.size === 0)
            return yield* new IntegrationRejected({
              reason: `It lists its tools to each account. Connect yours in Settings to check now.`,
            });
          yield* listEach(integrationId, owners);
        }),

        setTool: Effect.fn("IntegrationService.setTool")(function* (integrationId, tool, setting) {
          yield* adminServer(integrationId);
          const value = {
            ...(setting.off ? { off: true as const } : {}),
            ...(setting.access ? { access: setting.access } : {}),
          };
          const written = yield* repo.setToolSetting(
            integrationId,
            tool,
            Object.keys(value).length ? value : null,
          );
          if (!written) return yield* unknownIntegration();
          yield* bus
            .publishGlobal({ type: "integrations.changed" })
            .pipe(Effect.catchCause(() => Effect.void));
          const counted = (yield* repo.listConfigs()).find((entry) => entry.id === integrationId);
          return yield* adminView(counted!);
        }),

        checkDueListings: listings.checkDueListings,

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
            accountKey: null,
            fingerprint,
          });
          if (!saved) return yield* connectOutdated();
          yield* listings.listForConnection(saved);
          yield* changed(userId);
        }),

        beginOAuth: oauth.beginOAuth,
        completeOAuth: oauth.completeOAuth,

        updatePreferences: Effect.fn("IntegrationService.updatePreferences")(
          function* (userId, connectionId, input) {
            const account = yield* repo.getConnection(userId, connectionId);
            if (!account)
              return yield* new IntegrationNotAvailable({ integrationId: null, connectionId });
            let scope = input.scope;
            if (scope) {
              const row = yield* repo.getConfig(account.integrationId);
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
            // A blank name goes back to what the service reports.
            const name =
              input.name === undefined ? undefined : input.name?.trim().slice(0, 60) || null;
            const updated = yield* repo.updatePreferences(userId, connectionId, {
              ...input,
              ...(scope === undefined ? {} : { scope }),
              ...(name === undefined ? {} : { name }),
            });
            if (!updated)
              return yield* new IntegrationNotAvailable({
                integrationId: account.integrationId,
                connectionId,
              });
            yield* changed(userId);
          },
        ),

        scopeOptions: Effect.fn("IntegrationService.scopeOptions")(
          function* (userId, connectionId) {
            const session = yield* sessionFor(userId, connectionId);
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

        disconnect: Effect.fn("IntegrationService.disconnect")(function* (userId, connectionId) {
          yield* repo.removeConnection(userId, connectionId);
          yield* changed(userId);
        }),

        session: (userId, connectionId) => sessionFor(userId, connectionId),

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
