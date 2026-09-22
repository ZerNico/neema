import { Schema } from "effect";
import {
  useDraft,
  type DraftClient,
  type ReloadDraftOutcome,
  type SaveDraftOutcome,
} from "~/modules/drafts/client/use-draft.ts";
import { EMPTY_SCHEDULE_DRAFT, ScheduleDraftSettings } from "../draft-schema.ts";
import {
  discardScheduleDraft,
  getScheduleDraft,
  patchScheduleDraft,
  reloadScheduleDraft,
  saveScheduleDraft,
} from "../server/draft-functions.ts";

export type ScheduleDraftField = keyof ScheduleDraftSettings;
export const scheduleDraftClient: DraftClient<ScheduleDraftSettings> = {
  kind: "schedule",
  noun: "schedule",
  fields: Object.keys(EMPTY_SCHEDULE_DRAFT) as ScheduleDraftField[],
  empty: EMPTY_SCHEDULE_DRAFT,
  isValid: Schema.is(ScheduleDraftSettings),
  get: (draftId) => getScheduleDraft({ data: { draftId } }),
  patch: (data) => patchScheduleDraft({ data }),
  // The server names its outcomes after the target; the controller only
  // needs to know whether the target changed, vanished, or was written.
  save: async (data): Promise<SaveDraftOutcome<ScheduleDraftSettings>> => {
    const result = await saveScheduleDraft({ data });
    if (result.outcome === "saved")
      return { outcome: "saved", draft: result.draft, targetId: result.scheduleId };
    if (result.outcome === "invalid") return result;
    if (result.outcome === "schedule_changed") return { outcome: "target_changed", draft: result.draft };
    if (result.outcome === "schedule_unavailable")
      return { outcome: "target_unavailable", draft: result.draft };
    return { outcome: "conflict", draft: result.draft };
  },
  reload: async (data): Promise<ReloadDraftOutcome<ScheduleDraftSettings>> => {
    const result = await reloadScheduleDraft({ data });
    return result.outcome === "schedule_unavailable"
      ? { outcome: "target_unavailable", draft: result.draft }
      : { outcome: result.outcome, draft: result.draft };
  },
  discard: (data) => discardScheduleDraft({ data }),
  invalidateOnSave: (scheduleId) => [["schedules"], ["schedule", scheduleId]],
};

export const useScheduleDraft = (draftId: string, enabled = true) =>
  useDraft(scheduleDraftClient, draftId, enabled);
