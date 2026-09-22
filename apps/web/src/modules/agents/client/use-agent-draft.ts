import { Schema } from "effect";
import {
  useDraft,
  type DraftClient,
  type ReloadDraftOutcome,
  type SaveDraftOutcome,
} from "~/modules/drafts/client/use-draft.ts";
import { DraftSettings, EMPTY_AGENT_DRAFT } from "../draft-schema.ts";
import {
  discardAgentDraft,
  getAgentDraft,
  patchAgentDraft,
  reloadAgentDraft,
  saveAgentDraft,
} from "../server/draft-functions.ts";

export type DraftField = keyof DraftSettings;
export const agentDraftClient: DraftClient<DraftSettings> = {
  kind: "agent",
  noun: "agent",
  fields: Object.keys(EMPTY_AGENT_DRAFT) as DraftField[],
  empty: EMPTY_AGENT_DRAFT,
  isValid: Schema.is(DraftSettings),
  get: (draftId) => getAgentDraft({ data: { draftId } }),
  patch: (data) => patchAgentDraft({ data }),
  // The server names its outcomes after the target; the controller only
  // needs to know whether the target changed, vanished, or was written.
  save: async (data): Promise<SaveDraftOutcome<DraftSettings>> => {
    const result = await saveAgentDraft({ data });
    if (result.outcome === "saved")
      return { outcome: "saved", draft: result.draft, targetId: result.agentId };
    if (result.outcome === "invalid") return result;
    if (result.outcome === "agent_changed") return { outcome: "target_changed", draft: result.draft };
    if (result.outcome === "agent_unavailable")
      return { outcome: "target_unavailable", draft: result.draft };
    return { outcome: "conflict", draft: result.draft };
  },
  reload: async (data): Promise<ReloadDraftOutcome<DraftSettings>> => {
    const result = await reloadAgentDraft({ data });
    return result.outcome === "agent_unavailable"
      ? { outcome: "target_unavailable", draft: result.draft }
      : { outcome: result.outcome, draft: result.draft };
  },
  discard: (data) => discardAgentDraft({ data }),
  invalidateOnSave: (agentId) => [
    ["agents", "list"],
    ["agents", "detail", agentId],
  ],
};

export const useAgentDraft = (draftId: string, enabled = true) =>
  useDraft(agentDraftClient, draftId, enabled);
