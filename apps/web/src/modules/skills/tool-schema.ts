import { Schema } from "effect";
export const SkillToolName = Schema.Literals(["load_skill", "read_skill_file"]);
export const SkillToolResult = Schema.Struct({
  ok: Schema.Boolean,
  skillId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  content: Schema.String,
  nextOffset: Schema.NullOr(Schema.Int),
  remainingOps: Schema.Int,
  error: Schema.optional(Schema.String),
  /** A binary file: its exact reference for tools that take files, never its bytes. */
  file: Schema.optional(
    Schema.Struct({ ref: Schema.String, mediaType: Schema.String, size: Schema.Int }),
  ),
});
export type SkillToolResult = typeof SkillToolResult.Type;
/** Display bounds: an activity row is a label, never a transport for package text. */
export const SKILL_ACTIVITY_LIMITS = { id: 128, name: 200, path: 240, error: 300 } as const;
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
export const SkillActivity = Schema.Struct({
  family: Schema.Literal("skill"),
  version: Schema.Literal(1),
  name: SkillToolName,
  skillId: bounded(SKILL_ACTIVITY_LIMITS.id),
  skillName: bounded(SKILL_ACTIVITY_LIMITS.name),
  path: bounded(SKILL_ACTIVITY_LIMITS.path),
  status: Schema.Literals(["running", "complete", "error"]),
  error: Schema.optional(bounded(SKILL_ACTIVITY_LIMITS.error)),
});
export type SkillActivity = typeof SkillActivity.Type;
const envelopeFields = {
  v: Schema.Literal(1),
  family: Schema.Literal("skill"),
  name: SkillToolName,
  callId: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
};
export const SkillToolEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    phase: Schema.Literal("start"),
    turnIndex: Schema.Int,
    callIndex: Schema.Int,
    textOffset: Schema.optionalKey(Schema.Int),
    skillId: bounded(SKILL_ACTIVITY_LIMITS.id),
    skillName: bounded(SKILL_ACTIVITY_LIMITS.name),
    path: bounded(SKILL_ACTIVITY_LIMITS.path),
  }),
  Schema.Struct({ ...envelopeFields, ...SkillActivity.fields, phase: Schema.Literal("result") }),
]);
const clamp = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
/** The only tool-result persistence/wire projection. No bodies or continuation transcript. */
export function projectSkillToolResult(
  name: typeof SkillToolName.Type,
  raw: unknown,
): SkillActivity | null {
  if (!Schema.is(SkillToolResult)(raw)) return null;
  return {
    family: "skill",
    version: 1,
    name,
    skillId: clamp(raw.skillId, SKILL_ACTIVITY_LIMITS.id),
    skillName: clamp(raw.name, SKILL_ACTIVITY_LIMITS.name),
    path: clamp(raw.path, SKILL_ACTIVITY_LIMITS.path),
    status: raw.ok ? "complete" : "error",
    ...(raw.error ? { error: clamp(raw.error, SKILL_ACTIVITY_LIMITS.error) } : {}),
  };
}
