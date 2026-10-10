import { Schema } from "effect";

export const DOCUMENT_LIMITS = {
  chars: 200_000,
  title: 200,
  /** Planned sections one new document may start with, and one's description. */
  outline: 30,
  intent: 200,
  /** Blocks one document may hold; past this the tree, not its Markdown, is the cost. */
  blocks: 5_000,
  /** Steps in one push; a keystroke batch is a handful. */
  steps: 2_000,
  /** Serialized length of one push's steps. */
  stepChars: 1_000_000,
  comment: 4_000,
  /** The commented text kept with a thread. */
  quote: 500,
  /** Comments one document may hold, replies included. */
  comments: 1_000,
} as const;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const DocumentTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/\S/),
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
export const RenameDocumentInput = Schema.Struct({
  documentId: ResourceId,
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
  /** Planned sections after the content, each one placeholder's intent. */
  outline: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(DOCUMENT_LIMITS.intent))).check(
      Schema.isMaxLength(DOCUMENT_LIMITS.outline),
    ),
  ),
  /** Who wrote the first text: the model by default, a person starting a blank one. */
  by: Schema.optionalKey(Schema.Literals(["user", "model"])),
});
export type CreateDocumentInput = typeof CreateDocumentInput.Type;
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

const CommentBody = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(DOCUMENT_LIMITS.comment),
);
/**
 * A comment. A new thread's ID comes from the editor, which marks the text
 * with it as it sends; naming an existing thread replies to it.
 */
export const CommentInput = Schema.Struct({
  documentId: ResourceId,
  threadId: ResourceId,
  body: CommentBody,
  /** A new thread's text, as the reader saw it. */
  quote: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DOCUMENT_LIMITS.quote))),
  /** Also sent to the assistant as a chat message. */
  toAssistant: Schema.optionalKey(Schema.Boolean),
  /** A new thread's cell on a sheet, by sheet, row and column IDs; `r2`/`c2` make it a range. */
  cell: Schema.optionalKey(
    Schema.Struct({
      sh: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      r: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      c: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      r2: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
      c2: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
    }),
  ),
});
export type CommentInput = typeof CommentInput.Type;
export const ResolveThreadInput = Schema.Struct({
  documentId: ResourceId,
  threadId: ResourceId,
  resolved: Schema.Boolean,
});
export type ResolveThreadInput = typeof ResolveThreadInput.Type;
export const DeleteCommentInput = Schema.Struct({
  documentId: ResourceId,
  commentId: ResourceId,
});
export type DeleteCommentInput = typeof DeleteCommentInput.Type;

export interface DocumentComment {
  id: string;
  threadId: string;
  /** Null for the assistant, or once the account is gone. */
  author: { id: string; name: string } | null;
  byAssistant: boolean;
  body: string;
  createdAt: string;
  /** On a thread's first comment only. */
  resolvedAt: string | null;
  /** On a thread's first comment only: the text it was about. */
  quote: string | null;
  /** Sent to the assistant; `answered` once it replied in the thread after it. */
  toAssistant: boolean;
  answered: boolean;
}

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
  /** Every comment, whenever one changes. */
  | { type: "comments"; comments: ReadonlyArray<DocumentComment> }
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
  /** A text document or a live sheet. */
  kind: "text" | "sheet";
  revision: number;
  lastEditedBy: "user" | "model";
  lastEditorUserId?: string | null;
  /** Whether this reader may change it: false for a project viewer. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What one model edit did: the blocks it wrote, or why it changed nothing. */
export type ApplyDocumentResult =
  | { outcome: "updated" | "unchanged"; document: EditableDocument; touched: string[] }
  | {
      outcome: "not_found" | "ambiguous" | "conflict" | "invalid" | "no_match" | "anchors_affected";
      document: EditableDocument;
      message: string;
    };
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
