import type { Effect, Schema } from "effect";
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
}

export interface AdapterToolResult {
  /** What the model reads. Bounded by the adapter. */
  readonly output: unknown;
  readonly sources?: ReadonlyArray<AdapterSource>;
}

export interface AdapterTool {
  /** Must match a manifest tool name; `adapters.test.ts` checks the pairing. */
  readonly name: string;
  readonly description: string;
  /**
   * Every field `Schema.optionalKey`: a key the model omits must reach the
   * handler, which explains it, instead of failing the whole generation.
   */
  readonly parameters: Schema.Struct<Schema.Struct.Fields>;
  readonly run: (
    session: IntegrationSession,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<AdapterToolResult, AdapterFailure>;
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
  readonly tools: ReadonlyArray<AdapterTool>;
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
