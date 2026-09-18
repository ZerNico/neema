import type { WebExecutionPolicy } from "./execution-policy.ts";
import { Effect, type Scope } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { urlReaderTool, type UrlReaderExecutor } from "./url-reader.ts";
import { webSearchTool, type WebSearchExecutor } from "./web-search.ts";

/**
 * Tool families build their definitions and handlers independently, then the
 * stream engine combines whichever groups apply to one generation.
 */
export interface ToolGroup {
  readonly toolkit: Toolkit.Any;
  readonly handlers: Record<string, unknown>;
}

export interface PreparedWebTools {
  tools: { search: boolean; reader: boolean };
  group: ToolGroup;
}

type DynamicToolkit = Toolkit.Toolkit<Record<string, Tool.Any>>;

const unavailable = () => Effect.succeed(null);

/**
 * The Effect toolkit API is statically typed around a fixed tuple of tools,
 * while this boundary deliberately combines runtime-optional groups. Keep the
 * cast here rather than spreading `any` through every executor and caller.
 */
export const mergeToolGroups = Effect.fn("tools.mergeToolGroups")(function* (
  groups: ReadonlyArray<ToolGroup>,
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
          .handler(input.indexer, input.authority, input.policy)
          .pipe(Effect.catchTag("ToolUnavailable", unavailable))
      : null;

  const tools = { search: search !== null, reader: reader !== null };
  if (search && reader) {
    return {
      tools,
      group: {
        toolkit: Toolkit.make(webSearchTool, urlReaderTool),
        handlers: { web_search: search, read_url: reader },
      },
    };
  }
  if (search) {
    return {
      tools,
      group: {
        toolkit: Toolkit.make(webSearchTool),
        handlers: { web_search: search },
      },
    };
  }
  if (reader) {
    return {
      tools,
      group: {
        toolkit: Toolkit.make(urlReaderTool),
        handlers: { read_url: reader },
      },
    };
  }
  return undefined;
});
