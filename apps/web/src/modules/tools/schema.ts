import { Schema } from "effect";
import { PresentationToolEnvelope } from "~/modules/presentations/tool-schema.ts";
import { SpreadsheetToolEnvelope } from "~/modules/spreadsheets/tool-schema.ts";
import { WordToolEnvelope } from "~/modules/word/tool-schema.ts";
import { ToolFileEnvelope } from "~/modules/chat/tool-file-schema.ts";
import { IntegrationToolEnvelope } from "~/modules/integrations/tool-schema.ts";
import { AgentDraftToolEnvelope } from "~/modules/agents/tool-schema.ts";
import { DocumentToolEnvelope } from "~/modules/documents/tool-schema.ts";
import { ProjectFileToolEnvelope } from "~/modules/projects/file-tool-schema.ts";
import { DesktopToolName, DesktopToolResult } from "~/modules/desktop/tool-schema.ts";
import { ResearchProgress } from "~/modules/chat/research-schema.ts";
import { AskUserResult } from "./ask-user-schema.ts";
import { ScheduleDraftToolEnvelope } from "~/modules/schedules/tool-schema.ts";
import { CustomToolEnvelope } from "~/modules/custom-tools/tool-schema.ts";
import { SkillToolEnvelope } from "~/modules/skills/tool-schema.ts";
import { KnowledgeToolEnvelope } from "~/modules/knowledge/tool-schema.ts";
import { PlanStep } from "./plan-schema.ts";
import { ToolLoadEnvelope } from "./tool-load-schema.ts";
import { AttachmentToolEnvelope } from "~/modules/chat/attachment-tool-schema.ts";
import { Source, WebSource } from "./source-schema.ts";
export { Source, WebSource, DocumentSource } from "./source-schema.ts";

export const RESEARCH_SEARCH_BUDGET = { default: 80, min: 12, max: 120 } as const;
const researchMaxSearchQueries = Schema.optionalKey(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(RESEARCH_SEARCH_BUDGET.min),
    Schema.isLessThanOrEqualTo(RESEARCH_SEARCH_BUDGET.max),
  ),
);

/**
 * Non-secret configuration for the web_search tool row (tools.config jsonb).
 * Where results come from is the ordered `search_providers` list.
 */
export const WebSearchConfig = Schema.Struct({
  maxResults: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  // Older rows omit this and use the shared default; no backfill is needed.
  researchMaxSearchQueries,
});
export type WebSearchConfig = typeof WebSearchConfig.Type;

const HOSTED_SEARCH_PROVIDER_KINDS = [
  "tavily",
  "brave",
  "exa",
  "serper",
  "jina",
  "langsearch",
] as const;
export const SEARCH_PROVIDER_KINDS = ["searxng", ...HOSTED_SEARCH_PROVIDER_KINDS] as const;
export const SearchProviderKind = Schema.Literals(SEARCH_PROVIDER_KINDS);
export type SearchProviderKind = typeof SearchProviderKind.Type;
const HostedSearchProviderKind = Schema.Literals(HOSTED_SEARCH_PROVIDER_KINDS);

const BaseUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/**
 * A provider's kind with its non-secret settings. Only SearXNG has any: the
 * hosted kinds have fixed endpoints and need just an API key.
 */
export const SearchProviderSettings = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("searxng"), baseUrl: BaseUrl }),
  Schema.Struct({ kind: HostedSearchProviderKind }),
]);
export type SearchProviderSettings = typeof SearchProviderSettings.Type;

/**
 * Non-secret configuration for the document_parser tool row. `kind` on the
 * row selects the backend; "local" is the in-process unpdf extractor.
 */
export const DocumentParserConfig = Schema.Struct({
  maxChars: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(500_000),
  ),
  maxPages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(2000)),
});
export type DocumentParserConfig = typeof DocumentParserConfig.Type;

/**
 * Non-secret configuration for the url_reader tool row.
 */
export const UrlReaderConfig = Schema.Struct({
  perPageCharCap: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(20000),
  ),
});
export type UrlReaderConfig = typeof UrlReaderConfig.Type;

const SearchQuery = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ReadableUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/**
 * Parameters the model supplies when calling web_search. Multiple queries let
 * one model turn cover different phrasings or facets of the same question.
 */
export const WebSearchParams = Schema.Struct({
  queries: Schema.Array(SearchQuery).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  // Not every provider or engine filters by date, so a dated search reaches
  // fewer of them and usually returns fewer results.
  timeRange: Schema.optionalKey(
    Schema.Literals(["day", "month", "year"]).annotate({
      description:
        "Only for questions about very recent events (today's news, this week's releases). " +
        "It narrows the search to far fewer sources, so leave it out otherwise; " +
        "put a year or version in the query instead.",
    }),
  ),
  language: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))),
});
export type WebSearchParams = typeof WebSearchParams.Type;

/**
 * Parameters the model supplies when calling read_url.
 */
export const UrlReadParams = Schema.Struct({
  urls: Schema.Array(ReadableUrl).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export type UrlReadParams = typeof UrlReadParams.Type;

/**
 * Per-source status shown live in the chat UI (favicon row).
 */
export const PageStatus = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "reading", "done", "error"]),
  error: Schema.optionalKey(Schema.String),
});
export type PageStatus = typeof PageStatus.Type;

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

/**
 * One result shape for every web tool. `targets` contains search queries for
 * web_search and URLs for read_url. Page bodies are returned to the model here
 * but are intentionally omitted from persisted tool-call summaries below.
 */
export const WebToolResult = Schema.Struct({
  ok: Schema.Boolean,
  targets: Schema.Array(Schema.String),
  resultCount: Schema.Number,
  pagesFetched: Schema.Number,
  results: Schema.Array(WebToolItem),
  failures: Schema.Array(WebToolFailure),
  pages: Schema.optionalKey(Schema.Array(PageStatus)),
  sources: Schema.optionalKey(Schema.Array(WebSource)),
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
/**
 * Mirrors the handler's closed rejection set. It is the only thing a rejected
 * save leaves behind: the arguments are never persisted or streamed.
 */
export const MemoryActivityReason = Schema.Literals([
  "invalid_content",
  "invalid_replaces",
  "unknown_ordinal",
  "empty",
  "too_long",
  "sensitive",
  "limit_reached",
  "protected",
  "source_changed",
  "disabled",
  "repeated",
  "failed",
  "invalid_scope",
  "read_only",
]);
export type MemoryActivityReason = typeof MemoryActivityReason.Type;

// Envelope persisted in message_chunks.delta for kind:"tool" markers.
// Every event carries an explicit family discriminator.
const researchEnvelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["research"]),
  name: Schema.Literals(["deep_research"]),
  callId: Schema.String,
  runId: Schema.String,
  turnIndex: Schema.Int,
  callIndex: Schema.Int,
  textOffset: Schema.optionalKey(Schema.Int),
  progress: ResearchProgress,
  sources: Schema.optionalKey(Schema.Array(Source)),
};
const planEnvelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["plan"]),
  callId: Schema.String,
  name: Schema.Literals(["update_plan"]),
};
/**
 * Tools the page runs on the user's own machine. `start` carries the arguments
 * because the page is the executor, not just a spectator: it needs the path or
 * command to act on, which no other family's start event has to say.
 */
const desktopEnvelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["desktop"]),
  callId: Schema.String,
  name: DesktopToolName,
};
export const ToolChunkEnvelope = Schema.Union([
  ToolFileEnvelope,
  ToolLoadEnvelope,
  AttachmentToolEnvelope,
  PresentationToolEnvelope,
  SpreadsheetToolEnvelope,
  WordToolEnvelope,
  AgentDraftToolEnvelope,
  IntegrationToolEnvelope,
  ScheduleDraftToolEnvelope,
  CustomToolEnvelope,
  DocumentToolEnvelope,
  ProjectFileToolEnvelope,
  KnowledgeToolEnvelope,
  SkillToolEnvelope,
  Schema.Struct({
    ...desktopEnvelopeFields,
    phase: Schema.Literals(["start"]),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    ...desktopEnvelopeFields,
    phase: Schema.Literals(["result"]),
    result: DesktopToolResult,
  }),
  Schema.Struct({
    ...planEnvelopeFields,
    phase: Schema.Literals(["start"]),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    ...planEnvelopeFields,
    phase: Schema.Literals(["result"]),
    ok: Schema.Boolean,
    // Only the latest list is ever published; the UI shows one collapsed row.
    steps: Schema.optionalKey(Schema.Array(PlanStep)),
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ ...researchEnvelopeFields, phase: Schema.Literals(["start"]) }),
  Schema.Struct({ ...researchEnvelopeFields, phase: Schema.Literals(["progress"]) }),
  Schema.Struct({ ...researchEnvelopeFields, phase: Schema.Literals(["result"]) }),
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
    runId: Schema.optionalKey(Schema.String),
    taskId: Schema.optionalKey(Schema.String),
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
    runId: Schema.optionalKey(Schema.String),
    taskId: Schema.optionalKey(Schema.String),
    phase: Schema.Literals(["progress"]),
    callId: Schema.String,
    name: Schema.String,
    summary: ToolSummary,
    pages: Schema.Array(PageStatus),
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    family: Schema.Literals(["web"]),
    runId: Schema.optionalKey(Schema.String),
    taskId: Schema.optionalKey(Schema.String),
    phase: Schema.Literals(["result"]),
    callId: Schema.String,
    name: Schema.String,
    ok: Schema.Boolean,
    summary: ToolSummary,
    pages: Schema.optionalKey(Schema.Array(PageStatus)),
    sources: Schema.optionalKey(Schema.Array(WebSource)),
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
    reason: Schema.optionalKey(MemoryActivityReason),
    /** Set when the save went to the chat's project instead of the person. */
    scope: Schema.optionalKey(Schema.Literal("project")),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type ToolChunkEnvelope = typeof ToolChunkEnvelope.Type;

/**
 * Admin server-fn inputs
 */
export const UpdateMemoryToolInput = Schema.Struct({
  enabled: Schema.Boolean,
});
export type UpdateMemoryToolInput = typeof UpdateMemoryToolInput.Type;

export const UpdateWebSearchToolInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  maxResults: Schema.optionalKey(WebSearchConfig.fields.maxResults),
  researchMaxSearchQueries: WebSearchConfig.fields.researchMaxSearchQueries,
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

const ProviderLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const ProviderSecret = Schema.String.check(Schema.isMaxLength(4000));

export const CreateSearchProviderInput = Schema.Struct({
  settings: SearchProviderSettings,
  label: ProviderLabel,
  secret: Schema.optionalKey(ProviderSecret),
});
export type CreateSearchProviderInput = typeof CreateSearchProviderInput.Type;

export const UpdateSearchProviderInput = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(ProviderLabel),
  enabled: Schema.optionalKey(Schema.Boolean),
  // The kind cannot change; a different kind is a different provider.
  settings: Schema.optionalKey(SearchProviderSettings),
  // empty string = keep the existing secret; clearSecret removes it
  secret: Schema.optionalKey(ProviderSecret),
  clearSecret: Schema.optionalKey(Schema.Boolean),
});
export type UpdateSearchProviderInput = typeof UpdateSearchProviderInput.Type;

export const SearchProviderOrderInput = Schema.Struct({
  ids: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
});

/**
 * Tests a saved provider, or the form being edited. A draft with an `id` and
 * an empty secret uses that provider's stored secret.
 */
export const TestSearchProviderInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  settings: SearchProviderSettings,
  secret: Schema.optionalKey(ProviderSecret),
});
export type TestSearchProviderInput = typeof TestSearchProviderInput.Type;
