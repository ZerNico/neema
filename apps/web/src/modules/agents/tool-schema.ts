import { Option, Schema } from "effect";
import type { Response } from "effect/unstable/ai";

export function redactAgentDraftPart(part: Response.AnyPart): Response.AnyPart {
  if (part.type !== "tool-call" && part.type !== "tool-result") return part;
  if (!Schema.is(AgentDraftToolName)(part.name)) return part;
  if (part.type === "tool-call") return { ...part, params: {} };
  const result = {
    ...projectAgentDraftResult(part.isFailure ? null : part.result),
    message: "The current draft and inspected options are in the trailing application data.",
  };
  return { ...part, result, encodedResult: result };
}

export const AgentDraftToolName = Schema.Literals([
  "draft_agent",
  "read_agent_draft",
  "list_agent_options",
  "update_agent_draft",
]);
export type AgentDraftToolName = typeof AgentDraftToolName.Type;
export const AgentDraftToolOutcome = Schema.Literals([
  "drafted",
  "read",
  "options",
  "updated",
  "unchanged",
  "conflict",
  "invalid",
  "unavailable",
]);
const ActivityId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const DraftField = Schema.Literals([
  "name",
  "description",
  "icon",
  "instructions",
  "modelId",
  "imageModelId",
  "searchEnabled",
  "planEnabled",
  "starters",
  "skillIds",
  "collectionIds",
]);
/**
 * Why a call did not update the draft. Handler-authored text only (schema
 * paths and fixed sentences); never provider or driver output, which goes to
 * the server log instead.
 */
export const AgentDraftFailureReason = Schema.String.check(Schema.isMaxLength(600));
export const AgentDraftActivityResult = Schema.Struct({
  outcome: AgentDraftToolOutcome,
  /** Which draft this row refers to, and the conversation that owns it. */
  draftId: Schema.optionalKey(ActivityId),
  draftConversationId: Schema.optionalKey(ActivityId),
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  changedFields: Schema.optionalKey(Schema.Array(DraftField).check(Schema.isMaxLength(10))),
});
export type AgentDraftActivityResult = typeof AgentDraftActivityResult.Type;

/**
 * Reconstruct explicitly: decoders alone must not decide which private tool fields
 * may enter a message row, SSE chunk, or cloned display snapshot.
 */
export function projectAgentDraftResult(value: unknown): AgentDraftActivityResult {
  const decoded = Schema.decodeUnknownOption(AgentDraftActivityResult)(value);
  if (Option.isNone(decoded)) return { outcome: "invalid" };
  const { outcome, revision, changedFields, draftId, draftConversationId } = decoded.value;
  return {
    outcome,
    ...(revision ? { revision } : {}),
    ...(changedFields ? { changedFields } : {}),
    ...(draftId ? { draftId } : {}),
    ...(draftConversationId ? { draftConversationId } : {}),
  };
}
/** The handler's own explanation for a call that did not update the draft. */
export function agentDraftFailureReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { outcome, message } = value as { outcome?: unknown; message?: unknown };
  if (typeof message !== "string" || !message) return undefined;
  const decoded = Schema.decodeUnknownOption(AgentDraftToolOutcome)(outcome);
  if (Option.isNone(decoded) || agentDraftResultOk({ outcome: decoded.value })) return undefined;
  return message.slice(0, 600);
}
export const agentDraftResultOk = (result: AgentDraftActivityResult) =>
  ["drafted", "read", "options", "updated", "unchanged"].includes(result.outcome);

const fields = {
  v: Schema.Literal(1),
  family: Schema.Literal("agent-draft"),
  callId: Schema.String,
  name: AgentDraftToolName,
};
export const AgentDraftToolEnvelope = Schema.Union([
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
    ...AgentDraftActivityResult.fields,
    reason: Schema.optionalKey(AgentDraftFailureReason),
  }),
]);
