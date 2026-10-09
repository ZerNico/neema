import type { Effect, Schema } from "effect";
import type { Reach } from "../consent.ts";
import type { IntegrationToolDefinition, IntegrationToolInfo } from "../manifest.ts";
import type {
  IntegrationAuthFailed,
  IntegrationRejected,
  IntegrationRequestFailed,
} from "../errors.ts";
import type {
  ElicitationAnswer,
  ElicitationPrompt,
  BrowseNode,
  ScopeOption,
  SourceRoot,
} from "../schema.ts";
import type { McpToolEntry } from "../mcp/catalog.ts";
import type { DiscoveredServer, StoredOAuthClient } from "./repo.ts";
import type { TokenOutcome, TokenSet } from "./oauth.ts";

export type AdapterFailure = IntegrationAuthFailed | IntegrationRequestFailed | IntegrationRejected;

/**
 * How a person connected: a fresh OAuth access token, or the values of the
 * manifest's API key fields as they were checked. Only the adapter knows how
 * the service wants either sent.
 */
export type Credential =
  | { readonly kind: "oauth"; readonly accessToken: string }
  | { readonly kind: "api_key"; readonly values: Readonly<Record<string, string>> }
  /** A service everyone reaches without signing in. */
  | { readonly kind: "none" };

/** What a handler gets: the admin's config and a usable credential on demand. */
export interface IntegrationSession {
  readonly config: Readonly<Record<string, string>>;
  readonly credential: Effect.Effect<Credential, IntegrationAuthFailed | IntegrationRequestFailed>;
  /**
   * The items of the manifest's scope this connection is limited to, read
   * fresh each time; null is everything. Reads return nothing outside it.
   */
  readonly scope: Effect.Effect<ReadonlyArray<string> | null>;
}

/** A citable item a tool returned; the tool layer numbers it. */
export interface AdapterSource {
  readonly externalId: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** The whole item was read, not just matched by a search. */
  readonly read: boolean;
}

/** A file a call returned, stored as an attachment of the answer. */
export interface AdapterFile {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface AdapterToolResult {
  /** What the model reads. Bounded by the adapter. */
  readonly output: unknown;
  readonly sources?: ReadonlyArray<AdapterSource>;
  /** The page a change produced, linked from the tool row. */
  readonly link?: { readonly title: string; readonly url: string };
  readonly files?: ReadonlyArray<AdapterFile>;
}

/**
 * A call checked and ready, before anyone decides on it. Preparing reads what
 * the call will touch from the service, so an approval names the real target
 * and the call that runs is the one that was approved: `execute` is never
 * prepared again after a wait.
 */
export interface PreparedCall {
  /** Names the target for an approval card; null keeps the definition's summary. */
  readonly summary: string | null;
  /**
   * Whom the call would contact under one of the manifest's allowances, read
   * from the service where the call names a stored item (a draft), so the
   * check sees what `execute` sends. Null contacts nobody.
   */
  readonly reach: Reach | null;
  /**
   * The scope items the call touches, read from the service where it names a
   * stored item (an issue's project), so a limited connection is checked
   * against where things are, not where the model says. A change in a scoped
   * integration must name them; null touches none by name (a search the
   * adapter narrows itself).
   */
  readonly scope: ReadonlyArray<string> | null;
  readonly execute: Effect.Effect<AdapterToolResult, AdapterFailure>;
}

/** A call that needs nothing from the service before it runs. */
export const ready = (execute: Effect.Effect<AdapterToolResult, AdapterFailure>): PreparedCall => ({
  summary: null,
  reach: null,
  scope: null,
  execute,
});

/** What the handler types read from a definition. */
type ToolShape = Pick<IntegrationToolDefinition, "name"> & { readonly parameters: Schema.Top };

/** What one call may do beyond its arguments, given by the tool layer per call. */
export interface CallContext {
  /**
   * Puts a service's question to the person and waits for the answer. Nobody
   * there to ask (a scheduled run), no answer in time, or Stop: declined.
   */
  readonly elicit: (prompt: ElicitationPrompt) => Effect.Effect<ElicitationAnswer>;
}

type Handler<Args> = (
  session: IntegrationSession,
  args: Args,
  /** Absent where nobody can be asked anything, such as a test or a check. */
  call?: CallContext,
) => Effect.Effect<PreparedCall, AdapterFailure>;

/** One handler per definition, typed by its parameters. A missing or extra one does not compile. */
export type IntegrationHandlers<Tools extends ReadonlyArray<ToolShape>> = {
  readonly [Tool in Tools[number] as Tool["name"]]: Handler<Tool["parameters"]["Type"]>;
};

export type ErasedHandler = Handler<unknown>;

/**
 * Where the per-tool types end. The toolkit decodes a call against the same
 * definition before the handler runs, so the arguments match by construction.
 */
export const integrationHandlers =
  <const Tools extends ReadonlyArray<ToolShape>>(_tools: Tools) =>
  (handlers: IntegrationHandlers<Tools>): Readonly<Record<string, ErasedHandler>> =>
    handlers as Readonly<Record<string, ErasedHandler>>;

/**
 * One tool as a generation offers it: what screens show, the parameters the
 * model is given, and the handler that prepares a call. Shipped tools carry
 * an Effect Schema; catalog tools carry the JSON Schema an admin approved.
 */
export interface OfferedTool extends IntegrationToolInfo {
  readonly parameters: Schema.Top | Readonly<Record<string, unknown>>;
  /** One line for the tool row and approval card, from the raw arguments. */
  summarize(args: unknown): string | null;
  /** The arguments as an approval card lists them, when the summary cannot say enough. */
  details?(args: unknown): ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly prepare: ErasedHandler;
}

/** One stored tool of a catalog type; MCP is the only one so far. */
export type CatalogEntry = McpToolEntry;

/**
 * For a type whose tools come from each integration's server: turns one
 * approved catalog entry into a tool, and lists and reviews the catalog.
 */
export interface CatalogAdapter {
  tool(integrationId: string, entry: CatalogEntry): OfferedTool | null;
  /**
   * What the server lists now, as unreviewed entries in its order. A tool
   * listed before keeps its model-facing name.
   */
  list(
    session: IntegrationSession,
    integrationId: string,
    previous: ReadonlyArray<CatalogEntry>,
  ): Effect.Effect<
    { entries: CatalogEntry[]; server: Record<string, string>; recheckAfterMs: number | null },
    AdapterFailure
  >;
  /** The entries a generation may offer, from what was approved and what the server lists now. */
  offer(
    approved: ReadonlyArray<CatalogEntry>,
    latest: ReadonlyArray<CatalogEntry> | null,
  ): CatalogEntry[];
  /** Names one listing, so an approval applies to exactly the listing the admin saw. */
  version(latest: ReadonlyArray<CatalogEntry>): string;
  /** The approved catalog after a review, or what is wrong with the decisions. */
  apply(
    approved: ReadonlyArray<CatalogEntry>,
    latest: ReadonlyArray<CatalogEntry>,
    decisions: ReadonlyArray<CatalogDecision>,
  ): { approved: CatalogEntry[] } | { error: string };
}

/** An admin's decision on one listed tool, by the server's own name for it. */
export interface CatalogDecision {
  readonly mcpName: string;
  readonly enabled: boolean;
  readonly access: "read" | "write" | "destructive";
}

/** How people may connect, when the admin's config decides it (MCP) rather than the type. */
export interface ConnectMethods {
  readonly oauth: boolean;
  readonly apiKey: boolean;
  /** Turned on without credentials of one's own; `shared` uses the admin's key. */
  readonly open: "none" | "shared" | null;
}

/**
 * An OAuth sign-in whose endpoints, issuer and client are found when it
 * starts, from the service itself (MCP authorization). The service keeps the
 * state, the cookie, storage and the refresh lock; this half speaks OAuth.
 */
export interface DiscoveredOAuth {
  begin(input: {
    config: Readonly<Record<string, string>>;
    integrationId: string;
    integrationName: string;
    redirectUri: string;
    /** Where a client metadata document can be served from, when public over HTTPS. */
    clientMetadataUrl: string | null;
    state: string;
    scopes: { granted: ReadonlyArray<string>; required: ReadonlyArray<string> };
    preregistered: { clientId: string; clientSecret: string | null } | null;
    storedClient: (issuer: string) => Effect.Effect<StoredOAuthClient | null>;
    saveClient: (issuer: string, client: StoredOAuthClient) => Effect.Effect<void>;
  }): Effect.Effect<
    { url: string; verifier: string; server: DiscoveredServer },
    IntegrationRejected
  >;
  complete(input: {
    server: DiscoveredServer;
    clientSecret: string | null;
    code: string;
    /** The `iss` the callback carried, checked against the recorded issuer. */
    iss: string | null;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<TokenSet, IntegrationRejected>;
  refresh(input: {
    server: DiscoveredServer;
    clientSecret: string | null;
    refreshToken: string;
  }): Effect.Effect<TokenOutcome>;
}

/** One remote document a source may mirror, with its place in the tree. */
export interface RemoteDocument {
  readonly externalId: string;
  /** Node ids from the top of the tree down to the parent. */
  readonly ancestors: ReadonlyArray<string>;
  readonly title: string;
  readonly url: string;
  /**
   * When it last changed. Null means the adapter knows it has not changed
   * since the `since` it was given, so the sync keeps what it stored.
   */
  readonly updatedAt: Date | null;
  /** Present when listing already returned the body. */
  readonly markdown?: string;
}

export interface KnowledgeAdapter {
  /** Children of a node; no parent lists the top level. */
  browse(
    session: IntegrationSession,
    parentId: string | null,
  ): Effect.Effect<ReadonlyArray<BrowseNode>, AdapterFailure>;
  /**
   * Every live document under the given nodes (the nodes included), so a
   * document not listed is gone. With `since`, the adapter may leave out
   * bodies and change times of documents unchanged since then; one that
   * cannot tell ignores it and reports everything. A root the service no
   * longer has, or no longer shows this account, is named in `missing`.
   */
  enumerate(
    session: IntegrationSession,
    roots: ReadonlyArray<string>,
    since: Date | null,
  ): Effect.Effect<
    { documents: ReadonlyArray<RemoteDocument>; missing: ReadonlyArray<string> },
    AdapterFailure
  >;
  fetch(
    session: IntegrationSession,
    externalId: string,
  ): Effect.Effect<
    { title: string; markdown: string; url: string; updatedAt: Date },
    AdapterFailure
  >;
}

export interface IntegrationAdapter {
  /** The manifest `kind` it implements. */
  readonly kind: string;
  /**
   * Validates and normalizes the admin config. The fingerprint names what
   * credentials were issued against; a change to it invalidates connections.
   */
  normalizeConfig(
    config: Readonly<Record<string, string>>,
  ): { config: Record<string, string>; fingerprint: string } | { error: string };
  readonly oauth: {
    authorizeUrl(config: Readonly<Record<string, string>>): string;
    tokenUrl(config: Readonly<Record<string, string>>): string;
    readonly scopes: ReadonlyArray<string>;
  } | null;
  /** Checks a credential and names the account it belongs to. */
  verify(session: IntegrationSession): Effect.Effect<{ accountLabel: string }, AdapterFailure>;
  /** The choices for the manifest's scope, for the person limiting their connection. */
  readonly scopeOptions:
    | ((session: IntegrationSession) => Effect.Effect<ReadonlyArray<ScopeOption>, AdapterFailure>)
    | null;
  /** Keyed by the manifest's tool names; `catalog.test.ts` checks the pairing. */
  readonly handlers: Readonly<Record<string, ErasedHandler>>;
  /** Present for a `catalog` type, whose tools are not in `handlers`. */
  readonly catalog?: CatalogAdapter;
  readonly connectMethods?: (config: Readonly<Record<string, string>>) => ConnectMethods;
  readonly discoveredOAuth?: DiscoveredOAuth;
  readonly knowledge: KnowledgeAdapter | null;
}

/**
 * Whether a document is mirrored. The nearest root above it decides the
 * default (`all` or `selected`), and the nearest rule between that root and
 * the document overrides it, so a page added later follows its parent and an
 * exclusion inside an included branch carves that part out again.
 */
export const isSelected = (
  document: Pick<RemoteDocument, "externalId" | "ancestors">,
  roots: ReadonlyArray<SourceRoot>,
) => {
  const path = [...document.ancestors, document.externalId];
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const root = roots.find((entry) => entry.nodeId === path[depth]);
    if (!root) continue;
    const rules = new Map(root.rules.map((rule) => [rule.nodeId, rule.mode]));
    for (let index = path.length - 1; index > depth; index--) {
      const mode = rules.get(path[index]!);
      if (mode) return mode === "include";
    }
    return root.mode === "all";
  }
  return false;
};
