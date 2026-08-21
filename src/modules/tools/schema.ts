import { Schema } from "effect";

// Non-secret configuration for the web_search tool row (tools.config jsonb).
export const WebSearchConfig = Schema.Struct({
  backend: Schema.Literals(["searxng"]),
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  maxResults: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  maxPagesFetched: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(5),
  ),
  perPageCharCap: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(20000),
  ),
});
export type WebSearchConfig = typeof WebSearchConfig.Type;

// Parameters the model supplies when calling web_search.
export const WebSearchParams = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  timeRange: Schema.optionalKey(Schema.Literals(["day", "month", "year"])),
  language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
});
export type WebSearchParams = typeof WebSearchParams.Type;

// Per-source status shown live in the chat UI (favicon row).
export const PageStatus = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "reading", "done", "error"]),
});
export type PageStatus = typeof PageStatus.Type;

// A citable source. `index` is assigned per assistant message (not per call), so
// a second search continues the numbering and a repeated URL keeps its first
// number — the model cites these as [^index].
export const Source = Schema.Struct({
  index: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  /** true when we fetched and extracted the page, false for snippet-only hits. */
  read: Schema.Boolean,
});
export type Source = typeof Source.Type;

// Envelope persisted in message_chunks.delta for kind:"tool" markers.
export const ToolChunkEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    phase: Schema.Literals(["start"]),
    callId: Schema.String,
    name: Schema.String,
    args: Schema.Struct({ query: Schema.String }),
  }),
  // Live progress while the tool runs (search hits found, pages being read).
  Schema.Struct({
    v: Schema.Literals([1]),
    phase: Schema.Literals(["progress"]),
    callId: Schema.String,
    name: Schema.String,
    summary: Schema.Struct({
      query: Schema.String,
      resultCount: Schema.optionalKey(Schema.Number),
    }),
    pages: Schema.Array(PageStatus),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    phase: Schema.Literals(["result"]),
    callId: Schema.String,
    name: Schema.String,
    ok: Schema.Boolean,
    summary: Schema.Struct({
      query: Schema.String,
      resultCount: Schema.optionalKey(Schema.Number),
      pagesFetched: Schema.optionalKey(Schema.Number),
    }),
    pages: Schema.optionalKey(Schema.Array(PageStatus)),
    sources: Schema.optionalKey(Schema.Array(Source)),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type ToolChunkEnvelope = typeof ToolChunkEnvelope.Type;

// Admin server-fn inputs
export const UpdateWebSearchToolInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  // empty string = keep existing secret; clearSecret removes it
  secret: Schema.optionalKey(Schema.String),
  clearSecret: Schema.optionalKey(Schema.Boolean),
  maxResults: Schema.optionalKey(WebSearchConfig.fields.maxResults),
  maxPagesFetched: Schema.optionalKey(WebSearchConfig.fields.maxPagesFetched),
  perPageCharCap: Schema.optionalKey(WebSearchConfig.fields.perPageCharCap),
});
export type UpdateWebSearchToolInput = typeof UpdateWebSearchToolInput.Type;

export const TestSearchConnectionInput = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  // empty = use stored secret
  secret: Schema.optionalKey(Schema.String),
});
export type TestSearchConnectionInput = typeof TestSearchConnectionInput.Type;
