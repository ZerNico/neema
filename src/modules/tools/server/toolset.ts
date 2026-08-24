import { Effect } from "effect";
import { Toolkit } from "effect/unstable/ai";
import type { SourceIndexer } from "./source-indexer.ts";
import type { UrlAuthority } from "./url-authority.ts";
import { urlReaderTool, type UrlReaderExecutor } from "./url-reader.ts";
import { webSearchTool, type WebSearchExecutor } from "./web-search.ts";

export interface PreparedWebToolkit {
  tools: { search: boolean; reader: boolean };
  // The concrete tool set varies with admin toggles; the gateway only needs
  // "some toolkit with handlers", which is also all the multi-turn loop uses.
  toolkit: Toolkit.WithHandler<any>;
}

// The web toolkit for one generation: whichever tools apply, wired to one
// shared citation indexer. `undefined` when none do — the stream engine then
// runs without tools at all.
//
// Search follows the user's per-message preference. The reader rides with an
// armed search so the model can open its hits, and is also offered independently
// when user text or prior tool results seeded URL authority.
export const prepareWebToolkit: (input: {
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  indexer: SourceIndexer;
  authority: UrlAuthority;
  /** The composer's web toggle: search is offered only when the user asked. */
  requestSearch: boolean;
}) => Effect.Effect<PreparedWebToolkit | undefined> = Effect.fn("tools.prepareWebToolkit")(
  function* (input) {
    // An unavailable tool is skipped, not fatal: validation only guarantees the
    // tools the user explicitly asked for, and an admin flipping one off
    // mid-conversation should degrade the toolkit, not kill the generation.
    const unavailable = () => Effect.succeed(null);
    const search = input.requestSearch
      ? yield* input.webSearch
          .handler(input.indexer, input.authority)
          .pipe(Effect.catchTag("ToolUnavailable", unavailable))
      : null;
    const reader =
      search !== null || input.authority.seeded
        ? yield* input.urlReader
            .handler(input.indexer, input.authority)
            .pipe(Effect.catchTag("ToolUnavailable", unavailable))
        : null;

    const tools = { search: search !== null, reader: reader !== null };
    if (search && reader) {
      const toolkit = Toolkit.make(webSearchTool, urlReaderTool);
      return {
        tools,
        toolkit: yield* toolkit.pipe(
          Effect.provide(toolkit.toLayer({ web_search: search, read_url: reader })),
        ),
      };
    }
    if (search) {
      const toolkit = Toolkit.make(webSearchTool);
      return {
        tools,
        toolkit: yield* toolkit.pipe(Effect.provide(toolkit.toLayer({ web_search: search }))),
      };
    }
    if (reader) {
      const toolkit = Toolkit.make(urlReaderTool);
      return {
        tools,
        toolkit: yield* toolkit.pipe(Effect.provide(toolkit.toLayer({ read_url: reader }))),
      };
    }
    return undefined;
  },
);
