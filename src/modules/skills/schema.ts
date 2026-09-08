import { Schema } from "effect";
import type { SkillSource } from "~/db/schema/skills.ts";
import type { SkillFile, SkillFinding } from "./package.ts";

/**
 * skills.sh ignores `offset`/`page`, so more results means a larger page. The
 * ordering is stable, so rows already on screen keep their place.
 */
export const DISCOVERY_PAGE = 20;
export const DISCOVERY_MAX = 100;

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  manualOnly: boolean;
  audience: "private" | "instance";
  canEdit: boolean;
  ownerName: string | null;
  revision: number;
  updatedAt: string;
}
export interface SkillDetail extends SkillSummary {
  /** Only owner detail endpoints return content. */
  files: SkillFile[];
  findings: SkillFinding[];
  source: SkillSource | null;
  revisionId: string;
}
export interface SkillManifestEntry {
  skillId: string;
  revisionId: string;
  name: string;
  description: string;
  manualOnly: boolean;
  explicit: boolean;
  /** Offered from the library rather than selected: never fails an attempt. */
  ambient?: boolean;
}
export const SkillIdInput = Schema.Struct({
  skillId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export const SkillFileInput = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(240)),
  content: Schema.String.check(Schema.isMaxLength(262144)),
});
export const SaveSkillInput = Schema.Struct({
  skillId: Schema.optional(Schema.String),
  expectedRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  files: Schema.Array(SkillFileInput).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
