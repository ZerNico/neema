import { Schema } from "effect";
import { AskUserResult } from "./ask-user-schema.ts";

// Non-secret configuration for the web_search tool row (tools.config jsonb).
export const WebSearchConfig = Schema.Struct({
  backend: Schema.Literals(["searxng"]),
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  maxResults: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
});
export type WebSearchConfig = typeof WebSearchConfig.Type;

// Non-secret configuration for the document_parser tool row. `kind` on the
// row selects the backend; "local" is the in-process unpdf extractor.
export const DocumentParserConfig = Schema.Struct({
  maxChars: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(500_000),
  ),
  maxPages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2000)),
});
export type DocumentParserConfig = typeof DocumentParserConfig.Type;

// Non-secret configuration for the url_reader tool row.
export const UrlReaderConfig = Schema.Struct({
  perPageCharCap: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(20000),
  ),
});
export type UrlReaderConfig = typeof UrlReaderConfig.Type;

const SearchQuery = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ReadableUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

// Parameters the model supplies when calling web_search. Multiple queries let
// one model turn cover different phrasings or facets of the same question.
export const WebSearchParams = Schema.Struct({
  queries: Schema.Array(SearchQuery).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  timeRange: Schema.optionalKey(Schema.Literals(["day", "month", "year"])),
  language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
});
export type WebSearchParams = typeof WebSearchParams.Type;

// Parameters the model supplies when calling read_url.
export const UrlReadParams = Schema.Struct({
  urls: Schema.Array(ReadableUrl).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export type UrlReadParams = typeof UrlReadParams.Type;

// Per-source status shown live in the chat UI (favicon row).
export const PageStatus = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "reading", "done", "error"]),
  error: Schema.optionalKey(Schema.String),
});
export type PageStatus = typeof PageStatus.Type;

// A citable source. `index` is conversation-scoped: the allocator is seeded
// from earlier messages' persisted sources, so a repeated URL keeps its first
// number and new sources continue the sequence — the model cites [^index].
export const Source = Schema.Struct({
  index: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  /** true when read_url extracted the page, false for snippet-only search hits. */
  read: Schema.Boolean,
});
export type Source = typeof Source.Type;

export const WebToolFailure = Schema.Struct({
  target: Schema.String,
  error: Schema.String,
});
export type WebToolFailure = typeof WebToolFailure.Type;

const WebToolItem = Schema.Struct({
  index: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String,
  content: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
});

// One result shape for every web tool. `targets` contains search queries for
// web_search and URLs for read_url. Page bodies are returned to the model here
// but are intentionally omitted from persisted tool-call summaries below.
export const WebToolResult = Schema.Struct({
  ok: Schema.Boolean,
  targets: Schema.Array(Schema.String),
  resultCount: Schema.Number,
  pagesFetched: Schema.Number,
  results: Schema.Array(WebToolItem),
  failures: Schema.Array(WebToolFailure),
  pages: Schema.optionalKey(Schema.Array(PageStatus)),
  sources: Schema.optionalKey(Schema.Array(Source)),
  error: Schema.optionalKey(Schema.String),
});
export type WebToolResult = typeof WebToolResult.Type;

const ToolSummary = Schema.Struct({
  targets: Schema.Array(Schema.String),
  resultCount: Schema.optionalKey(Schema.Number),
  pagesFetched: Schema.optionalKey(Schema.Number),
});

export const MemoryActivityOutcome = Schema.Literals([
  "created",
  "updated",
  "unchanged",
  "rejected",
]);
export type MemoryActivityOutcome = typeof MemoryActivityOutcome.Type;

// Envelope persisted in message_chunks.delta for kind:"tool" markers. `family`
// is required on newly written markers; the client still treats its absence on
// historical web markers as family:"web".
export const ToolChunkEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["ask"]),
    phase: Schema.Literals(["start"]),
    callId: Schema.String,
    name: Schema.String,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["ask"]),
    phase: Schema.Literals(["result"]),
    callId: Schema.String,
    name: Schema.String,
    result: AskUserResult,
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["web"]),
    phase: Schema.Literals(["start"]),
    callId: Schema.String,
    name: Schema.String,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    args: Schema.Struct({ targets: Schema.Array(Schema.String) }),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["web"]),
    phase: Schema.Literals(["progress"]),
    callId: Schema.String,
    name: Schema.String,
    summary: ToolSummary,
    pages: Schema.Array(PageStatus),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["web"]),
    phase: Schema.Literals(["result"]),
    callId: Schema.String,
    name: Schema.String,
    ok: Schema.Boolean,
    summary: ToolSummary,
    pages: Schema.optionalKey(Schema.Array(PageStatus)),
    sources: Schema.optionalKey(Schema.Array(Source)),
    failures: Schema.optionalKey(Schema.Array(WebToolFailure)),
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["memory"]),
    phase: Schema.Literals(["start"]),
    callId: Schema.String,
    name: Schema.String,
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["memory"]),
    phase: Schema.Literals(["result"]),
    callId: Schema.String,
    name: Schema.String,
    ok: Schema.Boolean,
    outcome: Schema.optionalKey(MemoryActivityOutcome),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type ToolChunkEnvelope = typeof ToolChunkEnvelope.Type;

// Admin server-fn inputs
export const UpdateMemoryToolInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type UpdateMemoryToolInput = typeof UpdateMemoryToolInput.Type;

export const UpdateWebSearchToolInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  // empty string = keep existing secret; clearSecret removes it
  secret: Schema.optionalKey(Schema.String),
  clearSecret: Schema.optionalKey(Schema.Boolean),
  maxResults: Schema.optionalKey(WebSearchConfig.fields.maxResults),
});
export type UpdateWebSearchToolInput = typeof UpdateWebSearchToolInput.Type;

export const UpdateDocumentParserToolInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  maxChars: Schema.optionalKey(DocumentParserConfig.fields.maxChars),
  maxPages: Schema.optionalKey(DocumentParserConfig.fields.maxPages),
});
export type UpdateDocumentParserToolInput = typeof UpdateDocumentParserToolInput.Type;

export const UpdateUrlReaderToolInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  perPageCharCap: Schema.optionalKey(UrlReaderConfig.fields.perPageCharCap),
});
export type UpdateUrlReaderToolInput = typeof UpdateUrlReaderToolInput.Type;

export const TestSearchConnectionInput = Schema.Struct({
  baseUrl: Schema.String.check(Schema.isMinLength(1)),
  // empty = use stored secret
  secret: Schema.optionalKey(Schema.String),
});
export type TestSearchConnectionInput = typeof TestSearchConnectionInput.Type;
