import { Option, Schema } from "effect";
import type { Response } from "effect/unstable/ai";

export const DocumentToolName = Schema.Literals([
  "create_document",
  "edit_document",
  "read_chat_document",
  "replace_document",
  "list_chat_documents",
]);
export type DocumentToolName = typeof DocumentToolName.Type;
export const DocumentToolOutcome = Schema.Literals([
  "created",
  "updated",
  "unchanged",
  "read",
  "listed",
  "no_match",
  "ambiguous",
  "conflict",
  "invalid",
  "unavailable",
]);
export type DocumentToolOutcome = typeof DocumentToolOutcome.Type;
const ActivityId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
/**
 * Handler-authored text only: schema paths and fixed sentences. Never document
 * content and never provider output, which goes to the server log instead.
 */
export const DocumentFailureReason = Schema.String.check(Schema.isMaxLength(600));
export const DocumentActivityResult = Schema.Struct({
  outcome: DocumentToolOutcome,
  /** Which document this row refers to, and the conversation that owns it. */
  documentId: Schema.optionalKey(ActivityId),
  documentConversationId: Schema.optionalKey(ActivityId),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  message: Schema.optionalKey(DocumentFailureReason),
});
export type DocumentActivityResult = typeof DocumentActivityResult.Type;

/**
 * Reconstruct explicitly: decoders alone must not decide which private tool
 * fields may enter a message row, SSE chunk, or cloned display snapshot.
 */
export function projectDocumentResult(value: unknown): DocumentActivityResult {
  const decoded = Schema.decodeUnknownOption(DocumentActivityResult)(value);
  if (Option.isNone(decoded)) return { outcome: "invalid" };
  const { outcome, documentId, documentConversationId, title, revision, message } = decoded.value;
  return {
    outcome,
    ...(documentId ? { documentId } : {}),
    ...(documentConversationId ? { documentConversationId } : {}),
    ...(title ? { title } : {}),
    ...(revision ? { revision } : {}),
    ...(message ? { message } : {}),
  };
}
export const documentResultOk = (result: Pick<DocumentActivityResult, "outcome">) =>
  ["created", "updated", "unchanged", "read", "listed"].includes(result.outcome);
/** The handler's own explanation for a call that did not update a document. */
export function documentFailureReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { outcome, message } = value as { outcome?: unknown; message?: unknown };
  if (typeof message !== "string" || !message) return undefined;
  const decoded = Schema.decodeUnknownOption(DocumentToolOutcome)(outcome);
  if (Option.isNone(decoded) || documentResultOk({ outcome: decoded.value })) return undefined;
  return message.slice(0, 600);
}

export function redactDocumentPart(part: Response.AnyPart): Response.AnyPart {
  if (part.type !== "tool-call" && part.type !== "tool-result") return part;
  if (!Schema.is(DocumentToolName)(part.name)) return part;
  if (part.type === "tool-call") return { ...part, params: {} };
  // A failure keeps its own hint (why the anchor missed) beside the pointer;
  // the document itself only ever travels in the trailing data.
  const projected = projectDocumentResult(part.isFailure ? null : part.result);
  const pointer = "The current document is in the trailing application data.";
  const result = {
    ...projected,
    message: projected.message ? `${projected.message} ${pointer}` : pointer,
  };
  return { ...part, result, encodedResult: result };
}

const fields = {
  v: Schema.Literal(1),
  family: Schema.Literal("document"),
  callId: Schema.String,
  name: DocumentToolName,
};
export const DocumentToolEnvelope = Schema.Union([
  Schema.Struct({
    ...fields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    ...fields,
    phase: Schema.Literal("result"),
    ...DocumentActivityResult.fields,
    reason: Schema.optionalKey(DocumentFailureReason),
  }),
]);
export type DocumentToolEnvelope = typeof DocumentToolEnvelope.Type;
