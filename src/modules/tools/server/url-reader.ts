import { Context, Effect, Layer } from "effect";
import { Tool } from "effect/unstable/ai";
import { UrlReadParams, type PageStatus } from "../schema.ts";
import { PageExtractor } from "./extraction.ts";
import { ToolsRepo } from "./repo.ts";
import type { SourceIndexer } from "./source-indexer.ts";
import { ToolUnavailable, WebToolResult, type WebToolResult as Result } from "./web-search.ts";

// Reads one page the user (via the model) pointed at. Speaks the shared
// WebToolResult shape so the streaming pipeline, envelopes, persistence and
// citations treat it exactly like a search that found a single source.
// PageExtractor owns the SSRF boundary: scheme/credential checks plus
// private-address rejection on the URL and on every redirect hop.

export const urlReaderTool = Tool.make("read_url", {
  description:
    "Fetch and read one web page the user pointed at (or a page you learned about from " +
    "search results). Returns the page's extracted main content as markdown. Use when the " +
    "user provides a URL or asks about a specific page; use web_search when you need to " +
    "find pages first.",
  parameters: UrlReadParams,
  success: WebToolResult,
  failureMode: "return",
});

/** The first markdown-ish line trimmed to snippet length for the source list. */
const snippetOf = (content: string): string => {
  const line = content
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, 200);
};

export class UrlReaderExecutor extends Context.Service<
  UrlReaderExecutor,
  {
    /** The generation's shared indexer keeps citation numbers unique across tools. */
    handler(
      indexer: SourceIndexer,
    ): Effect.Effect<
      (
        params: UrlReadParams,
        ctx: { preliminary: (result: Result) => Effect.Effect<void> },
      ) => Effect.Effect<Result>,
      ToolUnavailable
    >;
    availability(): Effect.Effect<{ configured: boolean; enabled: boolean }>;
  }
>()("chat/tools/UrlReaderExecutor") {
  static readonly layer = Layer.effect(
    UrlReaderExecutor,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const extractor = yield* PageExtractor;

      const makeHandler = Effect.fn("UrlReaderExecutor.handler")(function* (
        indexer: SourceIndexer,
      ) {
        const tool = yield* repo.getUrlReader();
        if (!tool) {
          return yield* new ToolUnavailable({ tool: "read_url", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "read_url", reason: "disabled" });
        }
        const { config } = tool;

        return Effect.fnUntraced(function* (
          params: UrlReadParams,
          ctx: { preliminary: (result: Result) => Effect.Effect<void> },
        ) {
          const requested = params.url.trim();
          const base = { query: requested, resultCount: 0, pagesFetched: 0, results: [] };
          const page = (status: PageStatus["status"], title?: string): PageStatus[] => [
            { url: requested, ...(title !== undefined ? { title } : {}), status },
          ];

          yield* ctx.preliminary({ ok: true, ...base, pages: page("reading") });

          return yield* extractor.extract({ url: requested, charCap: config.perPageCharCap }).pipe(
            Effect.map((extracted): Result => {
              // Cite the final post-redirect URL — it's what the sources panel
              // links to and what a later search hit is deduped against.
              const title = extracted.title ?? new URL(extracted.url).hostname;
              const index = indexer.indexFor(extracted.url);
              const snippet = snippetOf(extracted.content);
              return {
                ok: true,
                query: requested,
                resultCount: 1,
                pagesFetched: 1,
                results: [
                  {
                    index,
                    title,
                    url: extracted.url,
                    snippet,
                    content: extracted.content,
                    ...(extracted.truncated ? { truncated: true } : {}),
                  },
                ],
                pages: [{ url: extracted.url, title, status: "done" }],
                sources: [{ index, url: extracted.url, title, snippet, read: true }],
              };
            }),
            Effect.catchTag("PageExtractionError", (e) =>
              Effect.succeed<Result>({
                ok: false,
                ...base,
                pages: page("error"),
                error: e.message,
              }),
            ),
          );
        });
      });

      const availability = Effect.fn("UrlReaderExecutor.availability")(function* () {
        const tool = yield* repo.getTool("read_url");
        return { configured: tool !== null, enabled: tool?.enabled ?? false };
      });

      return UrlReaderExecutor.of({ handler: makeHandler, availability });
    }),
  );
}
