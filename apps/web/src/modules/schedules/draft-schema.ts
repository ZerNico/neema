import { Schema, Struct } from "effect";
import { ScheduleSettings } from "./schema.ts";
import type { ConversationDraft } from "~/modules/drafts/draft-schema.ts";

/** Working input retains unfinished text; only the explicit Save validates a schedule. */
export const ScheduleDraftSettings = ScheduleSettings;
export type ScheduleDraftSettings = typeof ScheduleDraftSettings.Type;
export const ScheduleDraftPatch = ScheduleDraftSettings.mapFields(Struct.map(Schema.optionalKey));
export type ScheduleDraftPatch = typeof ScheduleDraftPatch.Type;
/**
 * What the model may change. Integration grants are authority a run uses with
 * nobody present, so only the person sets them, in the editor or draft panel.
 */
export const ScheduleModelPatch = ScheduleDraftPatch.mapFields(Struct.omit(["integrationGrants"]));
export type ScheduleModelPatch = typeof ScheduleModelPatch.Type;

export const EMPTY_SCHEDULE_DRAFT: ScheduleDraftSettings = {
  name: "",
  scheduleText: "",
  cron: "",
  timezone: "UTC",
  endAt: null,
  prompt: "",
  modelId: null,
  agentId: null,
  imageModelId: null,
  searchEnabled: false,
  researchEnabled: false,
  collectionIds: [],
  skillIds: [],
  chatMode: "new",
  chatId: null,
  notify: "always",
};

export interface ScheduleDraft extends ConversationDraft<ScheduleDraftSettings> {
  kind: "schedule";
}

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ScheduleDraftIdInput = Schema.Struct({ draftId: ResourceId });
export const ScheduleDraftRevisionInput = Schema.Struct({
  ...ScheduleDraftIdInput.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ScheduleDraftRevisionInput = typeof ScheduleDraftRevisionInput.Type;
/** Opening is per conversation; the draft it resolves to may already exist. */
export const OpenScheduleDraftInput = Schema.Struct({
  conversationId: ResourceId,
  createdByMessageId: ResourceId,
  scheduleId: Schema.optionalKey(ResourceId),
  changes: Schema.optionalKey(ScheduleDraftPatch),
});
export type OpenScheduleDraftInput = typeof OpenScheduleDraftInput.Type;
export interface OpenScheduleDraftResult {
  outcome: "drafted" | "read";
  draft: ScheduleDraft;
}
export const PatchScheduleDraftInput = Schema.Struct({
  ...ScheduleDraftRevisionInput.fields,
  changes: ScheduleDraftPatch,
});
export type PatchScheduleDraftInput = typeof PatchScheduleDraftInput.Type;
export interface PatchScheduleDraftResult {
  outcome: "updated" | "unchanged" | "conflict";
  draft: ScheduleDraft;
}
export type SaveScheduleDraftResult =
  | { outcome: "saved"; draft: ScheduleDraft; scheduleId: string }
  | { outcome: "conflict" | "schedule_changed" | "schedule_unavailable"; draft: ScheduleDraft }
  | { outcome: "invalid"; draft: ScheduleDraft; reason: string };
export interface ReloadScheduleDraftResult {
  outcome: "reloaded" | "conflict" | "schedule_unavailable" | "no_target";
  draft: ScheduleDraft;
}
