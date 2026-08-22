import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { ToolsRepo } from "./repo.ts";
import { SearchBackend } from "./search.ts";
import { PageExtractor } from "./extraction.ts";
import { WebSearchParams, type PageStatus, type Source } from "../schema.ts";

export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()("ToolUnavailable", {
  tool: Schema.String,
  reason: Schema.String,
}) {}

// Hard ceiling on the total tool-result payload handed to the model,
// independent of the admin-configured per-page cap.
const MAX_TOTAL_CHARS = 60_000;

const PageStatusSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "reading", "done", "error"]),
});

const SourceSchema = Schema.Struct({
  index: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  read: Schema.Boolean,
});

const WebSearchResult = Schema.Struct({
  ok: Schema.Boolean,
  query: Schema.String,
  resultCount: Schema.Number,
  pagesFetched: Schema.Number,
  results: Schema.Array(
    Schema.Struct({
      // The citation number the model must use for this source: [^index].
      index: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String,
      content: Schema.optionalKey(Schema.String),
      truncated: Schema.optionalKey(Schema.Boolean),
      fetchError: Schema.optionalKey(Schema.String),
    }),
  ),
  // Per-page fetch status; drives the live activity UI (preliminary results)
  // and the durable source list. Not meaningful to the model.
  pages: Schema.optionalKey(Schema.Array(PageStatusSchema)),
  // Citable sources (no page bodies) — persisted and rendered as chips/panel.
  sources: Schema.optionalKey(Schema.Array(SourceSchema)),
  error: Schema.optionalKey(Schema.String),
});
export type WebSearchResult = typeof WebSearchResult.Type;

export const webSearchTool = Tool.make("web_search", {
  description:
    "Search the web for current information. Returns search results with extracted page content. " +
    "Use for questions about recent events, facts you are unsure about, or anything the user asks to look up.",
  parameters: WebSearchParams,
  success: WebSearchResult,
  // Handler failures become tool results the model can react to.
  failureMode: "return",
});

export const webSearchToolkit = Toolkit.make(webSearchTool);
export type WebSearchToolkitWithHandler = Toolkit.WithHandler<typeof webSearchToolkit.tools>;

// Builds the ready-to-use toolkit for a generation run. Loads config once so a
// run keeps a stable snapshot even if an admin edits the tool mid-stream.
export class WebSearchExecutor extends Context.Service<
  WebSearchExecutor,
  {
    prepare(seed?: {
      // Citation numbering is conversation-scoped (Onyx-style): the caller
      // seeds the counter and URL map from sources persisted on earlier
      // messages so numbers stay stable and unique across the conversation.
      sources: ReadonlyArray<{ index: number; url: string }>;
    }): Effect.Effect<WebSearchToolkitWithHandler, ToolUnavailable>;
    // Cheap check used by ChatService validation + composer availability.
    availability(): Effect.Effect<{ configured: boolean; enabled: boolean }>;
  }
>()("chat/tools/WebSearchExecutor") {
  static readonly layer = Layer.effect(
    WebSearchExecutor,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const backend = yield* SearchBackend;
      const extractor = yield* PageExtractor;

      const prepare = Effect.fn("WebSearchExecutor.prepare")(function* (seed?: {
        sources: ReadonlyArray<{ index: number; url: string }>;
      }) {
        const tool = yield* repo.getWebSearch();
        if (!tool) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "not configured" });
        }
        if (!tool.enabled) {
          return yield* new ToolUnavailable({ tool: "web_search", reason: "disabled" });
        }
        const { config, secret } = tool;
        const connection = { baseUrl: config.baseUrl, secret };

        // Conversation-scoped citation numbering: seeded from earlier
        // messages' sources, so a URL cited before keeps its number and new
        // sources continue the sequence instead of colliding with old indexes.
        const seedSources = seed?.sources ?? [];
        let nextIndex = seedSources.reduce((max, s) => Math.max(max, s.index), 0) + 1;
        const indexByUrl = new Map<string, number>(seedSources.map((s) => [s.url, s.index]));
        const indexFor = (url: string): number => {
          const existing = indexByUrl.get(url);
          if (existing !== undefined) return existing;
          const assigned = nextIndex++;
          indexByUrl.set(url, assigned);
          return assigned;
        };

        const handler = Effect.fnUntraced(function* (
          params: WebSearchParams,
          ctx: { preliminary: (result: WebSearchResult) => Effect.Effect<void> },
        ) {
          const rawHits = yield* backend
            .search(connection, {
              query: params.query,
              maxResults: config.maxResults,
              ...(params.timeRange !== undefined ? { timeRange: params.timeRange } : {}),
              ...(params.language !== undefined ? { language: params.language } : {}),
            })
            .pipe(
              Effect.catchTag("SearchBackendError", (e) =>
                Effect.succeed<ReadonlyArray<never> | { error: string }>({ error: e.message }),
              ),
            );

          if (!Array.isArray(rawHits)) {
            return {
              ok: false,
              query: params.query,
              resultCount: 0,
              pagesFetched: 0,
              results: [],
              error: (rawHits as { error: string }).error,
            } satisfies WebSearchResult;
          }
          // Backend URLs are untrusted input: everything here is persisted,
          // rendered as links, and fetched — admit only http(s) once, at the
          // boundary, instead of validating at each of those sinks.
          const hits = rawHits.filter((hit) => /^https?:\/\//i.test(hit.url));

          // Fetch + extract the first maxPagesFetched pages, bounded concurrency.
          // Per-page status is streamed to the UI via preliminary results on
          // every transition (pending → reading → done/error).
          const toFetch = hits.slice(0, config.maxPagesFetched);
          const pages: PageStatus[] = toFetch.map((hit) => ({
            url: hit.url,
            title: hit.title,
            status: "pending",
          }));
          const setStatus = (url: string, status: PageStatus["status"]) => {
            const idx = pages.findIndex((p) => p.url === url);
            if (idx !== -1) pages[idx] = { ...pages[idx]!, status };
          };
          const progress = (over?: Partial<WebSearchResult>) =>
            ctx.preliminary({
              ok: true,
              query: params.query,
              resultCount: hits.length,
              pagesFetched: 0,
              results: [],
              pages: pages.map((p) => ({ ...p })),
              ...over,
            } as WebSearchResult);

          // Search finished: announce hits + which pages we're about to read.
          yield* progress();

          const extracted = yield* Effect.forEach(
            toFetch,
            (hit) =>
              Effect.gen(function* () {
                setStatus(hit.url, "reading");
                yield* progress();
                return yield* extractor
                  .extract({ url: hit.url, charCap: config.perPageCharCap })
                  .pipe(
                    Effect.map((page) => {
                      setStatus(hit.url, "done");
                      return { hit, page, error: null as string | null };
                    }),
                    Effect.catchTag("PageExtractionError", (e) => {
                      setStatus(hit.url, "error");
                      return Effect.succeed({ hit, page: null, error: e.message });
                    }),
                    Effect.tap(() => progress()),
                  );
              }),
            { concurrency: 3 },
          );

          let total = 0;
          const sources: Source[] = [];
          const results = hits.map((hit) => {
            const fetched = extracted.find((e) => e.hit.url === hit.url);
            const index = indexFor(hit.url);
            const read = fetched?.page != null;
            sources.push({
              index,
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              read,
            });
            const base = { index, title: hit.title, url: hit.url, snippet: hit.snippet };
            if (!fetched) return base;
            if (fetched.error !== null) return { ...base, fetchError: fetched.error };
            const page = fetched.page!;
            // Enforce the global ceiling across pages.
            const room = Math.max(0, MAX_TOTAL_CHARS - total);
            const content =
              page.content.length > room
                ? `${page.content.slice(0, room)}\n\n[content truncated]`
                : page.content;
            total += content.length;
            return {
              ...base,
              content,
              truncated: page.truncated || page.content.length > room,
            };
          });

          return {
            ok: true,
            query: params.query,
            resultCount: hits.length,
            pagesFetched: extracted.filter((e) => e.error === null).length,
            results,
            pages,
            sources,
          } satisfies WebSearchResult;
        });

        return yield* webSearchToolkit.pipe(
          Effect.provide(webSearchToolkit.toLayer({ web_search: handler })),
        );
      });

      const availability = Effect.fn("WebSearchExecutor.availability")(function* () {
        const tool = yield* repo.getTool("web_search");
        return { configured: tool !== null, enabled: tool?.enabled ?? false };
      });

      return WebSearchExecutor.of({ prepare, availability });
    }),
  );
}
