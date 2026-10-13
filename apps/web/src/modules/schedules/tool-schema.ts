import { Option, Schema } from "effect";
import type { Response } from "effect/unstable/ai";

export function redactScheduleDraftPart(part: Response.AnyPart): Response.AnyPart {
  if (part.type !== "tool-call" && part.type !== "tool-result") return part;
  if (!Schema.is(ScheduleDraftToolName)(part.name)) return part;
  if (part.type === "tool-call") return { ...part, params: {} };
  const result = {
    ...projectScheduleDraftResult(part.isFailure ? null : part.result),
    message: "The current draft and inspected options are in the trailing application data.",
  };
  return { ...part, result, encodedResult: result };
}

export const ScheduleDraftToolName = Schema.Literals([
  "draft_schedule",
  "read_schedule_draft",
  "update_schedule_draft",
]);
export type ScheduleDraftToolName = typeof ScheduleDraftToolName.Type;
export const ScheduleDraftToolOutcome = Schema.Literals([
  "drafted",
  "read",
  "updated",
  "unchanged",
  "conflict",
  "invalid",
  "unavailable",
]);
const ActivityId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ScheduleDraftField = Schema.Literals([
  "name",
  "scheduleText",
  "cron",
  "timezone",
  "endAt",
  "prompt",
  "modelId",
  "agentId",
  "imageModelId",
  "searchEnabled",
  "researchEnabled",
  "collectionIds",
  "skillIds",
  "chatMode",
  "chatId",
  "notify",
]);
/**
 * Why a call did not update the draft. Handler-authored text only (schema
 * paths and fixed sentences); never provider or driver output, which goes to
 * the server log instead.
 */
export const ScheduleDraftFailureReason = Schema.String.check(Schema.isMaxLength(600));
export const ScheduleDraftActivityResult = Schema.Struct({
  outcome: ScheduleDraftToolOutcome,
  /** Which draft this row refers to, and the conversation that owns it. */
  draftId: Schema.optionalKey(ActivityId),
  draftConversationId: Schema.optionalKey(ActivityId),
  revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  changedFields: Schema.optionalKey(Schema.Array(ScheduleDraftField).check(Schema.isMaxLength(15))),
});
export type ScheduleDraftActivityResult = typeof ScheduleDraftActivityResult.Type;

/**
 * Reconstruct explicitly: decoders alone must not decide which private tool fields
 * may enter a message row, SSE chunk, or cloned display snapshot.
 */
export function projectScheduleDraftResult(value: unknown): ScheduleDraftActivityResult {
  const decoded = Schema.decodeUnknownOption(ScheduleDraftActivityResult)(value);
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
export function scheduleDraftFailureReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { outcome, message } = value as { outcome?: unknown; message?: unknown };
  if (typeof message !== "string" || !message) return undefined;
  const decoded = Schema.decodeUnknownOption(ScheduleDraftToolOutcome)(outcome);
  if (Option.isNone(decoded) || scheduleDraftResultOk({ outcome: decoded.value })) return undefined;
  return message.slice(0, 600);
}
export const scheduleDraftResultOk = (result: ScheduleDraftActivityResult) =>
  ["drafted", "read", "updated", "unchanged"].includes(result.outcome);

const fields = {
  v: Schema.Literal(1),
  family: Schema.Literal("schedule-draft"),
  callId: Schema.String,
  name: ScheduleDraftToolName,
};
export const ScheduleDraftToolEnvelope = Schema.Union([
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
    ...ScheduleDraftActivityResult.fields,
    reason: Schema.optionalKey(ScheduleDraftFailureReason),
  }),
]);
