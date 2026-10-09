import { Schema } from "effect";

export const DOCUMENT_LIMITS = {
  chars: 200_000,
  title: 200,
  noMatchPreviewLines: 40,
  /** Steps in one push; a keystroke batch is a handful. */
  steps: 2_000,
  /** Serialized length of one push's steps. */
  stepChars: 1_000_000,
} as const;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
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
/** One ProseMirror step, `JSON.stringify(step.toJSON())`; the server rebuilds and checks it. */
const StepJson = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(DOCUMENT_LIMITS.stepChars),
);
/** Where one editor's selection sits, at the document version it was taken in. */
export const DocumentPresence = Schema.Struct({
  anchor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  head: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  user: Schema.Struct({
    name: Schema.String.check(Schema.isMaxLength(200)),
    color: Schema.String.check(Schema.isMaxLength(200)),
    colorLight: Schema.String.check(Schema.isMaxLength(200)),
  }),
});
export type DocumentPresence = typeof DocumentPresence.Type;
/**
 * A person's editor: steps built on `revision`, and/or its cursor. Steps on
 * an older revision are refused; the editor rebases over what its stream
 * brings and sends them again.
 */
export const PushDocumentInput = Schema.Struct({
  documentId: ResourceId,
  /** The editor's collab client id, so it recognises its own steps coming back. */
  clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  steps: Schema.optionalKey(
    Schema.Array(StepJson).check(Schema.isMinLength(1), Schema.isMaxLength(DOCUMENT_LIMITS.steps)),
  ),
  presence: Schema.optionalKey(DocumentPresence),
});
export type PushDocumentInput = typeof PushDocumentInput.Type;

/** What the live document stream sends. */
export type DocumentFrame =
  | {
      /** The whole document, for an editor with nothing usable to rebase from. */
      type: "reset";
      doc: Record<string, unknown>;
      revision: number;
    }
  | {
      /** Steps after `revision - steps.length`, each with the client that sent it. */
      type: "steps";
      steps: ReadonlyArray<Record<string, unknown>>;
      clientIds: ReadonlyArray<string>;
      revision: number;
    }
  | { type: "presence"; clientId: string; presence: DocumentPresence | null }
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
/** `conflict`: the steps were built on an older revision; rebase and send again. */
export interface PushDocumentResult {
  revision: number;
  conflict: boolean;
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
