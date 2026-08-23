import { Effect } from "effect";
import { Toolkit } from "effect/unstable/ai";

export interface PreparedWebToolkit {
  tools: { search: boolean; reader: boolean };
  // The concrete tool set varies with admin toggles; the gateway only needs
  // "some toolkit with handlers", which is also all the multi-turn loop uses.
  toolkit: Toolkit.WithHandler<any>;
}
import { urlReaderTool, type UrlReaderExecutor } from "./url-reader.ts";
import { webSearchTool, type WebSearchExecutor } from "./web-search.ts";
import type { SourceIndexer } from "./source-indexer.ts";

// The web toolkit for one generation: whichever of the two tools are admin-
// enabled, wired to one shared citation indexer. `undefined` when none are —
// the stream engine then runs without tools, exactly like searchEnabled=false.
export const prepareWebToolkit: (input: {
  webSearch: WebSearchExecutor["Service"];
  urlReader: UrlReaderExecutor["Service"];
  indexer: SourceIndexer;
}) => Effect.Effect<PreparedWebToolkit | undefined> = Effect.fn("tools.prepareWebToolkit")(
  function* (input) {
    // An unavailable tool is skipped, not fatal: validation only guarantees at
    // least one is enabled, and an admin flipping one off mid-conversation
    // should degrade the toolkit, not kill the generation.
    const unavailable = () => Effect.succeed(null);
    const search = yield* input.webSearch
      .handler(input.indexer)
      .pipe(Effect.catchTag("ToolUnavailable", unavailable));
    const reader = yield* input.urlReader
      .handler(input.indexer)
      .pipe(Effect.catchTag("ToolUnavailable", unavailable));

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
