import { Schema } from "effect";

export const DOCUMENT_LIMITS = { chars: 200_000, title: 200, noMatchPreviewLines: 40 } as const;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const DocumentTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DOCUMENT_LIMITS.title),
);

export const DocumentIdInput = Schema.Struct({ documentId: ResourceId });
export type DocumentIdInput = typeof DocumentIdInput.Type;
export const ConversationIdInput = Schema.Struct({ conversationId: ResourceId });
export const CreateDocumentInput = Schema.Struct({
  conversationId: ResourceId,
  /** The answer this document belongs to; rewinding past it deletes the document. */
  createdByMessageId: Schema.optionalKey(ResourceId),
  title: DocumentTitle,
  content: Schema.String,
});
export type CreateDocumentInput = typeof CreateDocumentInput.Type;
export const EditDocumentInput = Schema.Struct({
  documentId: ResourceId,
  old: Schema.String.check(Schema.isMinLength(1)),
  new: Schema.String,
  expectedRevision: Schema.optionalKey(Revision),
});
export type EditDocumentInput = typeof EditDocumentInput.Type;
export const ReplaceDocumentInput = Schema.Struct({
  documentId: ResourceId,
  content: Schema.String,
  expectedRevision: Revision,
});
export type ReplaceDocumentInput = typeof ReplaceDocumentInput.Type;
export const SaveDocumentInput = ReplaceDocumentInput;
export type SaveDocumentInput = typeof SaveDocumentInput.Type;
export const ToggleDocumentTaskInput = Schema.Struct({
  documentId: ResourceId,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checked: Schema.Boolean,
  expectedRevision: Schema.optionalKey(Revision),
});
export type ToggleDocumentTaskInput = typeof ToggleDocumentTaskInput.Type;

export interface ConversationDocument {
  id: string;
  conversationId: string;
  createdByMessageId?: string | null;
  title: string;
  content: string;
  revision: number;
  lastEditedBy: "user" | "model";
  createdAt: string;
  updatedAt: string;
}

export type EditDocumentResult =
  | { outcome: "updated" | "unchanged"; document: ConversationDocument; staleRead: boolean }
  | { outcome: "no_match"; document: ConversationDocument; preview: string; staleRead: boolean }
  | { outcome: "ambiguous"; document: ConversationDocument; count: number; staleRead: boolean };
export interface WriteDocumentResult {
  outcome: "updated" | "unchanged" | "conflict";
  document: ConversationDocument;
}
export type ToggleDocumentTaskResult =
  | { outcome: "updated" | "unchanged" | "conflict"; document: ConversationDocument }
  | { outcome: "no_match"; document: ConversationDocument };

export class DocumentNotAvailable extends Schema.TaggedError<DocumentNotAvailable>()(
  // Whichever identity the caller had: creation knows only the conversation.
  "DocumentNotAvailable",
  {
    documentId: Schema.optionalKey(Schema.String),
    conversationId: Schema.optionalKey(Schema.String),
  },
) {}
export class DocumentRejected extends Schema.TaggedError<DocumentRejected>()("DocumentRejected", {
  reason: Schema.String,
}) {}
