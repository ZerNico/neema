import type { WebExecutionPolicy } from "./execution-policy.ts";
import type { ToolFamily } from "../families.ts";
import { Effect, Result as EffectResult, Schema, type Scope } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { urlReaderTool, type UrlReaderExecutor } from "./url-reader.ts";
import { webSearchTool, type WebSearchExecutor } from "./web-search.ts";

/**
 * Tool families build their definitions and handlers independently, then the
 * stream engine combines whichever groups apply to one generation. A group
 * declares the family of every tool it carries; a call's row stores it.
 */
export interface ToolGroup {
  readonly family: ToolFamily;
  readonly toolkit: Toolkit.Any;
  readonly handlers: Record<string, unknown>;
}

/**
 * The family of each tool the groups offer, by name. A name missing here was
 * never offered: the toolkit runs no handler for it, so it gets no row.
 */
export const toolFamilies = (groups: ReadonlyArray<ToolGroup>): ReadonlyMap<string, ToolFamily> =>
  new Map(
    groups.flatMap((group) =>
      Object.keys(group.toolkit.tools).map((name) => [name, group.family] as const),
    ),
  );

export interface PreparedWebTools {
  tools: { search: boolean; reader: boolean };
  group: ToolGroup;
}

/**
 * A parameter the model is offered as `jsonSchema` but that decodes anything,
 * absent included, so the handler can explain a malformed call instead of the
 * whole generation failing at decode. `Any`, not `Unknown`: the generator drops
 * the annotation on `Unknown` and the model is offered `{}`.
 */
export const advertisedParameter = (jsonSchema: Record<string, unknown>) =>
  Schema.optionalKey(
    Schema.Any.check(Schema.makeFilter(() => true, { toJsonSchema: () => jsonSchema })),
  );

/** An `advertisedParameter` offering the model the JSON Schema of `schema` itself. */
export const advertisedAs = (schema: Schema.Top) =>
  advertisedParameter(Schema.toJsonSchemaDocument(schema).schema);

/**
 * Decodes what the model sent for an `advertisedAs` parameter, strictly. The
 * issue names paths and expected shapes, never the submitted values, so it can
 * go back to the model as a correction hint.
 */
export const decodeToolInput = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
): { ok: true; value: S["Type"] } | { ok: false; issue: string } => {
  const result = Effect.runSync(
    Effect.result(
      Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error", errors: "all" }),
    ),
  );
  return EffectResult.isSuccess(result)
    ? { ok: true, value: result.success }
    : { ok: false, issue: result.failure.message.replace(/\s+/g, " ").slice(0, 600) };
};

type DynamicToolkit = Toolkit.Toolkit<Record<string, Tool.Any>>;

const unavailable = () => Effect.succeed(null);

/**
 * The Effect toolkit API is statically typed around a fixed tuple of tools,
 * while this boundary deliberately combines runtime-optional groups. Keep the
 * cast here rather than spreading `any` through every executor and caller.
 */
export const mergeToolGroups = Effect.fn("tools.mergeToolGroups")(function* (
  groups: ReadonlyArray<Omit<ToolGroup, "family">>,
) {
  if (groups.length === 0) return undefined;

  const toolkit = Toolkit.merge(...groups.map((group) => group.toolkit)) as DynamicToolkit;
  const handlers = Object.assign({}, ...groups.map((group) => group.handlers));
  return yield* toolkit.pipe(Effect.provide(toolkit.toLayer(handlers as never)));
});

/**
 * The web tools for one generation: whichever tools apply, wired to one
 * shared citation indexer. `undefined` when neither applies.
 *
 * Search follows the user's per-message preference; the reader rides armed so
 * the model can open its hits, and is offered too when user text or prior
 * results seed URL authority.
 */
export const prepareWebTools: (input: {
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  indexer: SourceIndexer;
  authority: UrlAuthority;
  /** The composer's web toggle: search is offered only when the user asked. */
  requestSearch: boolean;
  policy?: WebExecutionPolicy;
  /** Whose answer the tools serve; see `UrlReaderExecutor.handler`. */
  owner: string;
}) => Effect.Effect<PreparedWebTools | undefined, never, Scope.Scope> = Effect.fn(
  "tools.prepareWebTools",
)(function* (input) {
  // An unavailable tool is skipped, not fatal: validation only guarantees the
  // tools the user explicitly asked for, and an admin flipping one off
  // mid-conversation should degrade the toolkit, not kill the generation.
  const search = input.requestSearch
    ? yield* input.webSearch
        .handler(input.indexer, input.authority, input.policy)
        .pipe(Effect.catchTag("ToolUnavailable", unavailable))
    : null;
  const reader =
    search !== null || input.authority.seeded
      ? yield* input.urlReader
          .handler(input.indexer, input.authority, input.policy, input.owner)
          .pipe(Effect.catchTag("ToolUnavailable", unavailable))
      : null;

  const tools = { search: search !== null, reader: reader !== null };
  if (search && reader) {
    return {
      tools,
      group: {
        family: "web",
        toolkit: Toolkit.make(webSearchTool, urlReaderTool),
        handlers: { web_search: search, read_url: reader },
      },
    };
  }
  if (search) {
    return {
      tools,
      group: {
        family: "web",
        toolkit: Toolkit.make(webSearchTool),
        handlers: { web_search: search },
      },
    };
  }
  if (reader) {
    return {
      tools,
      group: {
        family: "web",
        toolkit: Toolkit.make(urlReaderTool),
        handlers: { read_url: reader },
      },
    };
  }
  return undefined;
});
