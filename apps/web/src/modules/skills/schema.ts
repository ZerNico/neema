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
export interface SkillSaveResult {
  id: string;
  revision: number;
  /** Resolved files from this accepted save, never a later detail read. */
  files: SkillFile[];
}
export interface SkillManifestEntry {
  skillId: string;
  revisionId: string;
  name: string;
  description: string;
  manualOnly: boolean;
  /** Chosen in the composer for this message: its root loads before the first call. */
  explicit: boolean;
  /** Attached to the conversation's agent: offered on demand, and preferred. */
  fromAgent?: boolean;
  /** Offered from the library rather than selected: never fails an attempt. */
  ambient?: boolean;
}
export const SkillIdInput = Schema.Struct({
  skillId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
const SkillPath = Schema.String.check(Schema.isMaxLength(240));
/**
 * A binary file is never sent as bytes: it names bytes already stored for the
 * sender, either kept (`sha256`) or just uploaded (`uploadId`). The server
 * reads its real size and type from what is stored.
 */
export const SkillFileInput = Schema.Union([
  Schema.Struct({
    path: SkillPath,
    content: Schema.String.check(Schema.isMaxLength(262144)),
  }),
  Schema.Struct({
    path: SkillPath,
    binary: Schema.Struct({
      size: Schema.Number,
      mediaType: Schema.String.check(Schema.isMaxLength(200)),
      sha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
      uploadId: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
    }),
  }),
]);
export const SaveSkillInput = Schema.Struct({
  skillId: Schema.optional(Schema.String),
  expectedRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  files: Schema.Array(SkillFileInput).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
