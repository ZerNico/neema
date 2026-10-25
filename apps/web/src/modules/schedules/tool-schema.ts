import { defineDraftToolSchema } from "~/modules/drafts/tool-schema.ts";
import { ScheduleDraftSettings } from "./draft-schema.ts";

const schema = defineDraftToolSchema({
  family: "schedule-draft",
  toolNames: [
    "draft_schedule",
    "read_schedule_draft",
    "list_schedule_options",
    "update_schedule_draft",
  ],
  extraOutcomes: ["options"],
  settings: ScheduleDraftSettings,
});

export const ScheduleDraftToolName = schema.ToolName;
export type ScheduleDraftToolName = typeof ScheduleDraftToolName.Type;
export const ScheduleDraftActivityResult = schema.ActivityResult;
export type ScheduleDraftActivityResult = typeof ScheduleDraftActivityResult.Type;
export const ScheduleDraftToolEnvelope = schema.Envelope;
export const projectScheduleDraftResult = schema.projectResult;
export const scheduleDraftFailureReason = schema.failureReason;
export const scheduleDraftResultOk = schema.resultOk;
export const redactScheduleDraftPart = schema.redactPart;
