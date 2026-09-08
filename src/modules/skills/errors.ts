import { Schema } from "effect";

export class SkillNotAvailable extends Schema.TaggedError<SkillNotAvailable>()(
  "SkillNotAvailable",
  { skillId: Schema.String },
) {}
export class SkillRejected extends Schema.TaggedError<SkillRejected>()("SkillRejected", {
  reason: Schema.String,
}) {}
export class SkillConflict extends Schema.TaggedError<SkillConflict>()("SkillConflict", {
  skillId: Schema.String,
}) {}
