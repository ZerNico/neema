import { Option, Schema, Struct } from "effect";
import type { Response } from "effect/unstable/ai";

const ActivityId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
/** Outcomes every draft kind's tools can report; a kind adds its own (agents' "options"). */
const COMMON_OUTCOMES = [
  "drafted",
  "read",
  "updated",
  "unchanged",
  "conflict",
  "invalid",
  "unavailable",
] as const;
const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set(["drafted", "read", "updated", "unchanged"]);

/**
 * The activity row, stream envelope and transcript redaction of one draft kind's
 * tools. Each kind keeps its names, family and settings; the shapes are shared so
 * a privacy or drift fix lands once.
 */
export function defineDraftToolSchema<
  const Family extends string,
  const Names extends readonly [string, ...string[]],
  const Extra extends readonly string[],
  Fields extends Schema.Struct.Fields,
>(config: {
  family: Family;
  toolNames: Names;
  /** Successful outcomes beyond the common ones. */
  extraOutcomes: Extra;
  settings: Schema.Struct<Fields>;
}) {
  const ToolName = Schema.Literals(config.toolNames);
  const ToolOutcome = Schema.Literals([...COMMON_OUTCOMES, ...config.extraOutcomes]);
  const successOutcomes = new Set([...SUCCESS_OUTCOMES, ...config.extraOutcomes]);
  /** Derived from the settings, so a new field cannot fail the result after the patch commits. */
  const fields = Struct.keys(config.settings.fields);
  const Field = Schema.Literals(fields);
  /**
   * Why a call did not update the draft. Handler-authored text only (schema
   * paths and fixed sentences); never provider or driver output, which goes to
   * the server log instead.
   */
  const FailureReason = Schema.String.check(Schema.isMaxLength(600));
  const ActivityResult = Schema.Struct({
    outcome: ToolOutcome,
    /** Which draft this row refers to, and the conversation that owns it. */
    draftId: Schema.optionalKey(ActivityId),
    draftConversationId: Schema.optionalKey(ActivityId),
    revision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    changedFields: Schema.optionalKey(Schema.Array(Field).check(Schema.isMaxLength(fields.length))),
  });
  type ActivityResult = typeof ActivityResult.Type;
  const resultOk = (result: ActivityResult) => successOutcomes.has(result.outcome);

  /**
   * Reconstruct explicitly: decoders alone must not decide which private tool fields
   * may enter a message row, SSE chunk, or cloned display snapshot.
   */
  const projectResult = (value: unknown): ActivityResult => {
    const decoded = Schema.decodeUnknownOption(ActivityResult)(value);
    // The outcome union is generic over the kind's extras, so TS cannot see "invalid" in it.
    if (Option.isNone(decoded)) return { outcome: "invalid" as ActivityResult["outcome"] };
    const { outcome, revision, changedFields, draftId, draftConversationId } = decoded.value;
    return {
      outcome,
      ...(revision ? { revision } : {}),
      ...(changedFields ? { changedFields } : {}),
      ...(draftId ? { draftId } : {}),
      ...(draftConversationId ? { draftConversationId } : {}),
    };
  };
  /** The handler's own explanation for a call that did not update the draft. */
  const failureReason = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const { outcome, message } = value as { outcome?: unknown; message?: unknown };
    if (typeof message !== "string" || !message) return undefined;
    const decoded = Schema.decodeUnknownOption(ToolOutcome)(outcome);
    if (Option.isNone(decoded) || resultOk({ outcome: decoded.value })) return undefined;
    return message.slice(0, 600);
  };
  const redactPart = (part: Response.AnyPart): Response.AnyPart => {
    if (part.type !== "tool-call" && part.type !== "tool-result") return part;
    if (!Schema.is(ToolName)(part.name)) return part;
    if (part.type === "tool-call") return { ...part, params: {} };
    const result = {
      ...projectResult(part.isFailure ? null : part.result),
      message: "The current draft and inspected options are in the trailing application data.",
    };
    return { ...part, result, encodedResult: result };
  };

  const envelopeFields = {
    v: Schema.Literal(1),
    family: Schema.Literal(config.family),
    callId: Schema.String,
    name: ToolName,
  };
  const Envelope = Schema.Union([
    Schema.Struct({
      ...envelopeFields,
      phase: Schema.Literal("start"),
      turnIndex: Schema.Int,
      callIndex: Schema.Int,
      textOffset: Schema.optionalKey(Schema.Int),
    }),
    Schema.Struct({
      ...envelopeFields,
      phase: Schema.Literal("result"),
      ...ActivityResult.fields,
      reason: Schema.optionalKey(FailureReason),
    }),
  ]);

  return {
    ToolName,
    ToolOutcome,
    FailureReason,
    ActivityResult,
    Envelope,
    projectResult,
    failureReason,
    resultOk,
    redactPart,
  };
}
