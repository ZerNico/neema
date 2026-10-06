import type { Effect, Schema } from "effect";
import type { Reach } from "../consent.ts";
import type { IntegrationToolDefinition } from "../manifest.ts";
import type {
  IntegrationAuthFailed,
  IntegrationRejected,
  IntegrationRequestFailed,
} from "../errors.ts";
import type { BrowseNode, SourceRoot } from "../schema.ts";

export type AdapterFailure = IntegrationAuthFailed | IntegrationRequestFailed | IntegrationRejected;

/** What a handler gets: the admin's config and a fresh bearer on demand. */
export interface IntegrationSession {
  readonly config: Readonly<Record<string, string>>;
  readonly bearer: Effect.Effect<string, IntegrationAuthFailed | IntegrationRequestFailed>;
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

export interface AdapterToolResult {
  /** What the model reads. Bounded by the adapter. */
  readonly output: unknown;
  readonly sources?: ReadonlyArray<AdapterSource>;
  /** The page a change produced, linked from the tool row. */
  readonly link?: { readonly title: string; readonly url: string };
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
  readonly execute: Effect.Effect<AdapterToolResult, AdapterFailure>;
}

/** A call that needs nothing from the service before it runs. */
export const ready = (execute: Effect.Effect<AdapterToolResult, AdapterFailure>): PreparedCall => ({
  summary: null,
  reach: null,
  execute,
});

/** What the handler types read from a definition. */
type ToolShape = Pick<IntegrationToolDefinition, "name"> & { readonly parameters: Schema.Top };

type Handler<Args> = (
  session: IntegrationSession,
  args: Args,
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
  readonly id: string;
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
  /** Keyed by the manifest's tool names; `catalog.test.ts` checks the pairing. */
  readonly handlers: Readonly<Record<string, ErasedHandler>>;
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
