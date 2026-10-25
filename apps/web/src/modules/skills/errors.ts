import { Schema } from "effect";
import { Localized } from "~/i18n/localized.ts";

export class SkillNotAvailable extends Schema.TaggedError<SkillNotAvailable>()(
  "SkillNotAvailable",
  { skillId: Schema.String },
) {}
export class SkillRejected extends Schema.TaggedError<SkillRejected>()("SkillRejected", {
  reason: Localized,
}) {}
export class SkillConflict extends Schema.TaggedError<SkillConflict>()("SkillConflict", {
  skillId: Schema.String,
}) {}
