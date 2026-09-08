import { Schema } from "effect";

/** Bounds. Deliberately engineering constants, not admin settings. */
export const KNOWLEDGE_LIMITS = {
  maxCollectionsPerUser: 100,
  maxDocumentsPerCollection: 500,
  maxCollectionsPerSelection: 5,
  maxNameLength: 120,
  maxDescriptionLength: 500,
  /** Authored notes; files go through the blob path and its 20 MB ceiling. */
  maxNoteChars: 200_000,
  /** Extracted text kept per version. Longer documents fail instead of publishing partial content. */
  maxExtractedChars: 400_000,
  maxPages: 500,
  maxChunksPerVersion: 2_000,
  /** Inputs per embeddings request. */
  embeddingBatchSize: 32,
  embeddingMaxInputChars: 16_000,
  embeddingMaxBatchChars: 160_000,
  /** Concurrent provider embedding requests across the instance. */
  embeddingConcurrency: 2,
} as const;

export const KnowledgeAudience = Schema.Literals(["private", "instance"]);
export type KnowledgeAudience = typeof KnowledgeAudience.Type;

export const DocumentStatus = Schema.Literals(["queued", "extracting", "ready", "failed"]);
export type DocumentStatus = typeof DocumentStatus.Type;

export const SemanticStatus = Schema.Literals([
  /** No embedding model configured; lexical search only. */
  "disabled",
  "needs_reindex",
  "queued",
  "running",
  "ready",
  "failed",
]);
export type SemanticStatus = typeof SemanticStatus.Type;

export const CollectionSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  audience: KnowledgeAudience,
  /** False for a collection shared with the caller: read/use only. */
  canEdit: Schema.Boolean,
  ownerName: Schema.NullOr(Schema.String),
  documentCount: Schema.Int,
  readyCount: Schema.Int,
  failedCount: Schema.Int,
  pendingCount: Schema.Int,
  updatedAt: Schema.String,
});
export type CollectionSummary = typeof CollectionSummary.Type;

export const KnowledgeDocument = Schema.Struct({
  id: Schema.String,
  collectionId: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(["file", "note"]),
  status: DocumentStatus,
  semanticStatus: SemanticStatus,
  fileName: Schema.NullOr(Schema.String),
  mediaType: Schema.NullOr(Schema.String),
  byteSize: Schema.NullOr(Schema.Int),
  charCount: Schema.NullOr(Schema.Int),
  pageCount: Schema.NullOr(Schema.Int),
  /** Extraction hit a page/character limit: never claim full coverage. */
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  versionId: Schema.NullOr(Schema.String),
  replacement: Schema.NullOr(
    Schema.Struct({
      versionId: Schema.String,
      title: Schema.String,
      status: DocumentStatus,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  updatedAt: Schema.String,
});
export type KnowledgeDocument = typeof KnowledgeDocument.Type;

/**
 * One retrieved passage. `documentId`/`versionId`/`chunkId` are the citation
 * handle — an internal source is never addressed by a URL the model wrote.
 */
export const KnowledgePassage = Schema.Struct({
  collectionId: Schema.String,
  documentId: Schema.String,
  versionId: Schema.String,
  chunkId: Schema.String,
  title: Schema.String,
  headingPath: Schema.String,
  page: Schema.NullOr(Schema.Int),
  startOffset: Schema.Int,
  endOffset: Schema.Int,
  content: Schema.String,
});
export type KnowledgePassage = typeof KnowledgePassage.Type;

export const KnowledgeSearchMode = Schema.Literals(["hybrid", "lexical"]);
export type KnowledgeSearchMode = typeof KnowledgeSearchMode.Type;

/** Approved output-affecting connection, never credentials or display labels. */
export const EmbeddingConnection = Schema.Struct({
  providerId: Schema.String,
  baseUrl: Schema.String,
  modelKey: Schema.String,
  modelDimensions: Schema.NullOr(Schema.Int),
  preprocessingRevision: Schema.Int,
});
export type EmbeddingConnection = typeof EmbeddingConnection.Type;

/** Config for the `knowledge_search` tool row (tools.config jsonb). */
export const KnowledgeSearchConfig = Schema.Struct({
  spaceId: Schema.NullOr(Schema.String),
  embeddingModelId: Schema.NullOr(Schema.String),
  dimensions: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
  connectionRevision: Schema.NullOr(Schema.String),
  approvedConnection: Schema.NullOr(EmbeddingConnection),
});
export type KnowledgeSearchConfig = typeof KnowledgeSearchConfig.Type;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const EmbeddingConfigurationChange = Schema.Struct({
  modelId: ResourceId,
  dimensions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  decision: Schema.Literals(["keep", "rebuild"]),
  expectedRevision: Schema.NullOr(ResourceId),
});
export type EmbeddingConfigurationChange = typeof EmbeddingConfigurationChange.Type;
export const DisableEmbeddingInput = Schema.Struct({
  expectedRevision: Schema.NullOr(ResourceId),
});
export type DisableEmbeddingInput = typeof DisableEmbeddingInput.Type;
export interface EmbeddingConfigurationStatus {
  enabled: boolean;
  status: "disabled" | "ready" | "needs_approval";
  config: KnowledgeSearchConfig;
}

export const CollectionIdInput = Schema.Struct({ collectionId: ResourceId });
export const KnowledgeDocumentIdInput = Schema.Struct({ documentId: ResourceId });
export const CollectionIdentityInput = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNameLength),
  ),
  description: Schema.String.check(Schema.isMaxLength(KNOWLEDGE_LIMITS.maxDescriptionLength)),
});
export const UpdateCollectionInput = Schema.Struct({
  ...CollectionIdInput.fields,
  ...CollectionIdentityInput.fields,
});
export const AddKnowledgeNoteInput = Schema.Struct({
  ...CollectionIdInput.fields,
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNameLength),
  ),
  content: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxNoteChars),
  ),
});
export const ReadKnowledgeDocumentInput = Schema.Struct({
  ...CollectionIdInput.fields,
  ...KnowledgeDocumentIdInput.fields,
  versionId: ResourceId,
  startOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxChars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_000 })),
});

export const ReplaceKnowledgeNoteInput = Schema.Struct({
  ...AddKnowledgeNoteInput.fields,
  ...KnowledgeDocumentIdInput.fields,
});
