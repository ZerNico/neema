import { Schema, Struct } from "effect";
import { ScheduleSettings } from "./schema.ts";
import type { ConversationDraft } from "~/modules/drafts/draft-schema.ts";
import { EntityId } from "~/entity-id.ts";

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

export const ScheduleDraftIdInput = Schema.Struct({ draftId: EntityId });
export const ScheduleDraftRevisionInput = Schema.Struct({
  ...ScheduleDraftIdInput.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type ScheduleDraftRevisionInput = typeof ScheduleDraftRevisionInput.Type;
/** Opening is per conversation; the draft it resolves to may already exist. */
export const OpenScheduleDraftInput = Schema.Struct({
  conversationId: EntityId,
  createdByMessageId: EntityId,
  scheduleId: Schema.optionalKey(EntityId),
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
