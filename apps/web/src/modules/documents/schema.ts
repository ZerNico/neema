import { Schema } from "effect";

export const DOCUMENT_LIMITS = {
  chars: 200_000,
  title: 200,
  noMatchPreviewLines: 40,
  /** Base64 length of one pushed Yjs batch; a keystroke batch is tens of bytes. */
  update: 1_000_000,
  /** Base64 length of one awareness (cursor) update. */
  awareness: 8_000,
} as const;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const DocumentTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DOCUMENT_LIMITS.title),
);

export const DocumentIdInput = Schema.Struct({ documentId: ResourceId });
export type DocumentIdInput = typeof DocumentIdInput.Type;
export const ConversationIdInput = Schema.Struct({ conversationId: ResourceId });
export const ProjectDocumentsInput = Schema.Struct({ projectId: ResourceId });
export const CreateProjectDocumentInput = Schema.Struct({
  projectId: ResourceId,
  title: DocumentTitle,
});
/** Exactly one owner: a chat, or a project. */
export const CreateDocumentInput = Schema.Struct({
  conversationId: Schema.optionalKey(ResourceId),
  projectId: Schema.optionalKey(ResourceId),
  /** A chat document's answer; rewinding past it deletes the document. */
  createdByMessageId: Schema.optionalKey(ResourceId),
  title: DocumentTitle,
  content: Schema.String,
  /** Who wrote the first text: the model by default, a person starting a blank one. */
  by: Schema.optionalKey(Schema.Literals(["user", "model"])),
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
const Base64 = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  );
/** A person's editor: Yjs batches and cursor state, both optional so either can go alone. */
export const PushDocumentInput = Schema.Struct({
  documentId: ResourceId,
  /** The pushing Y.Doc's client id, so its own frames are not echoed back. */
  clientId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  update: Schema.optionalKey(Base64(DOCUMENT_LIMITS.update)),
  awareness: Schema.optionalKey(Base64(DOCUMENT_LIMITS.awareness)),
});
export type PushDocumentInput = typeof PushDocumentInput.Type;

/** What the live document stream sends; Yjs payloads are base64. */
export type DocumentFrame =
  | {
      type: "sync";
      /** Everything the subscriber lacks, diffed against the state vector it sent. */
      update: string;
      awareness: string | null;
      revision: number;
    }
  | { type: "update"; update: string; revision: number; clientId: number | null }
  | { type: "awareness"; update: string; clientId: number | null }
  /** The document was deleted, or this subscriber lost access to it. */
  | { type: "gone" };

/** A chat's or a project's document: exactly one of the two owners is set. */
export interface EditableDocument {
  id: string;
  conversationId: string | null;
  projectId: string | null;
  createdByMessageId?: string | null;
  title: string;
  content: string;
  revision: number;
  lastEditedBy: "user" | "model";
  lastEditorUserId?: string | null;
  /** Whether this reader may change it: false for a project viewer. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export type EditDocumentResult =
  | { outcome: "updated" | "unchanged"; document: EditableDocument; staleRead: boolean }
  | { outcome: "no_match"; document: EditableDocument; preview: string; staleRead: boolean }
  | { outcome: "ambiguous"; document: EditableDocument; count: number; staleRead: boolean };
export interface WriteDocumentResult {
  outcome: "updated" | "unchanged" | "conflict";
  document: EditableDocument;
}
export interface PushDocumentResult {
  revision: number;
}

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
