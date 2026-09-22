import { Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import {
  DraftOwner,
  useDraftPanel,
  type DraftHandle,
  type DraftKindUi,
} from "~/modules/drafts/ui/draft-owner.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { useScheduleDraft } from "../client/use-schedule-draft.ts";
import type { ScheduleDraftSettings } from "../draft-schema.ts";
import { ScheduleSettingsFields } from "./schedule-settings-fields.tsx";

export type ScheduleDraftHandle = DraftHandle;

const ui: DraftKindUi<ScheduleDraftSettings> = {
  kind: "schedule",
  noun: "schedule",
  Noun: "Schedule",
  useController: useScheduleDraft,
  labels: {
    name: "Name",
    scheduleText: "Cadence",
    cron: "Cron",
    timezone: "Timezone",
    endAt: "End",
    prompt: "Prompt",
    modelId: "Preferred model",
    agentId: "Agent",
    searchEnabled: "Web search",
    researchEnabled: "Deep research",
    collectionIds: "Collections",
    skillIds: "Skills",
  },
  Fields: ScheduleSettingsFields,
  targetLink: (scheduleId) => (
    <Link
      to="/schedules/$scheduleId"
      params={{ scheduleId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      Open schedule
    </Link>
  ),
  copy: {
    saveEffect: "Saving changes updates when this schedule fires and what it asks.",
    createEffect: "The schedule is created only when you choose Create schedule.",
  },
};

export const useScheduleDraftPanel = (draftId: string) => useDraftPanel("schedule", draftId);

export function ScheduleDraftOwner(props: {
  draftIds: ReadonlyArray<string>;
  onGone: (draftId: string) => void;
  children: ReactNode;
  ref?: Ref<ScheduleDraftHandle> | undefined;
}) {
  return <DraftOwner ui={ui} {...props} />;
}
