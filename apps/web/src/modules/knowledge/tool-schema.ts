import { Option, Schema } from "effect";
import { DocumentSource } from "~/modules/tools/source-schema.ts";

export const KNOWLEDGE_TOOL_LIMITS = {
  operations: 64,
  concurrency: 3,
  resultTokens: 6_000,
  readChars: 16_000,
  pageSize: 20,
  /**
   * Characters of a chunk a search hit carries. ~200 tokens: enough to judge
   * relevance and cite, small enough that up to twelve hits fit one result.
   * The full chunk is one read_knowledge_document call away, at the exact range.
   */
  searchExcerptChars: 800,
} as const;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ListDocumentsParams = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const SearchKnowledgeParams = Schema.Struct({
  queries: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
});
export const ReadDocumentParams = Schema.Struct({
  documents: Schema.Array(
    Schema.Struct({
      documentId: Id,
      versionId: Id,
      startOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      maxChars: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: KNOWLEDGE_TOOL_LIMITS.readChars }),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});

const ListedDocument = Schema.Struct({
  collectionId: Id,
  documentId: Id,
  versionId: Schema.NullOr(Id),
  title: Schema.String,
  status: Schema.Literals(["ready", "pending", "failed"]),
  charCount: Schema.NullOr(Schema.Int),
  truncated: Schema.Boolean,
});
const Passage = Schema.Struct({
  source: DocumentSource,
  content: Schema.String,
  /** Null for a search hit whose full document size is not part of this result. */
  totalChars: Schema.NullOr(Schema.Int),
  nextOffset: Schema.NullOr(Schema.Int),
});
export const KnowledgeToolResult = Schema.Struct({
  ok: Schema.Boolean,
  targets: Schema.Array(Schema.String),
  documents: Schema.Array(ListedDocument),
  passages: Schema.Array(Passage),
  failures: Schema.Array(Schema.Struct({ target: Schema.String, error: Schema.String })),
  sources: Schema.Array(DocumentSource),
  totalCount: Schema.Int,
  nextCursor: Schema.NullOr(Schema.String),
  remainingOps: Schema.Int,
  coverage: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["hybrid", "lexical"])),
  degradedReason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type KnowledgeToolResult = typeof KnowledgeToolResult.Type;

/** Bodies are model-only. This is the only projection persisted in activity rows. */
export const KnowledgeActivitySummary = Schema.Struct({
  targets: Schema.Array(Schema.String),
  documentsListed: Schema.Int,
  passagesReturned: Schema.Int,
  remainingOps: Schema.Int,
  coverage: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["hybrid", "lexical"])),
});
export type KnowledgeActivitySummary = typeof KnowledgeActivitySummary.Type;
export const summarizeKnowledgeResult = (
  result: KnowledgeToolResult,
): KnowledgeActivitySummary => ({
  targets: result.targets,
  documentsListed: result.documents.length,
  passagesReturned: result.passages.length,
  remainingOps: result.remainingOps,
  coverage: result.coverage,
  ...(result.mode ? { mode: result.mode } : {}),
});

export const KnowledgeToolName = Schema.Literals([
  "list_knowledge_documents",
  "search_knowledge",
  "read_knowledge_document",
  "knowledge_context",
]);
export const KnowledgeActivityResult = Schema.Struct({
  family: Schema.Literals(["knowledge"]),
  ok: Schema.Boolean,
  summary: KnowledgeActivitySummary,
  sources: Schema.Array(DocumentSource),
  error: Schema.optionalKey(Schema.String),
});
export type KnowledgeActivityResult = typeof KnowledgeActivityResult.Type;

const envelopeFields = {
  v: Schema.Literals([1]),
  family: Schema.Literals(["knowledge"]),
  name: KnowledgeToolName,
  callId: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
};
export const KnowledgeToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literals(["start"]),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    /** Search queries, so the row can say what it is searching for while it runs. */
    targets: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    ...envelopeFields,
    ...KnowledgeActivityResult.fields,
    phase: Schema.Literals(["result"]),
  }),
]);

export const knowledgeActivityResult = (result: KnowledgeToolResult): KnowledgeActivityResult =>
  Schema.decodeUnknownSync(KnowledgeActivityResult)({
    family: "knowledge",
    ok: result.ok,
    summary: summarizeKnowledgeResult(result),
    sources: result.sources,
    ...(result.error ? { error: result.error } : {}),
  });

/** Ordinary chat and research share the same untrusted-result boundary. */
export const projectKnowledgeToolResult = (
  result: unknown,
  isFailure: boolean,
  remainingOps: number,
): KnowledgeActivityResult => {
  const decoded = Schema.decodeUnknownOption(KnowledgeToolResult)(result);
  if (!isFailure && Option.isSome(decoded)) return knowledgeActivityResult(decoded.value);
  return {
    family: "knowledge",
    ok: false,
    summary: { targets: [], documentsListed: 0, passagesReturned: 0, remainingOps, coverage: "" },
    sources: [],
    error: "knowledge tool failed",
  };
};
