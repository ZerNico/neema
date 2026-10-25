import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import {
  DraftOwner,
  type DraftHandle,
  type DraftKindUi,
} from "~/modules/drafts/ui/draft-owner.tsx";
import { m } from "~/paraglide/messages.js";
import { buttonVariants } from "~/ui/primitives/button";
import { useScheduleDraft } from "../client/use-schedule-draft.ts";
import type { ScheduleDraftSettings } from "../draft-schema.ts";
import { ScheduleSettingsFields } from "./schedule-settings-fields.tsx";

export type ScheduleDraftHandle = DraftHandle;

const ui: DraftKindUi<ScheduleDraftSettings> = {
  kind: "schedule",
  icon: Calendar03Icon,
  useController: useScheduleDraft,
  labels: {
    name: m.schedules_field_name,
    scheduleText: m.schedules_field_schedule_text,
    cron: m.schedules_field_cron,
    timezone: m.schedules_field_timezone,
    endAt: m.schedules_field_end_at,
    prompt: m.schedules_field_prompt,
    modelId: m.schedules_field_model,
    imageModelId: m.schedules_field_image_model,
    agentId: m.schedules_field_agent,
    searchEnabled: m.schedules_field_web_search,
    researchEnabled: m.schedules_field_deep_research,
    collectionIds: m.schedules_field_collections,
    skillIds: m.schedules_field_skills,
    integrationGrants: m.schedules_field_integrations,
    chatMode: m.schedules_field_chat_mode,
    notify: m.schedules_field_notify,
    chatId: m.schedules_field_chat,
  },
  Fields: ScheduleSettingsFields,
  targetLink: (scheduleId) => (
    <Link
      to="/schedules/$scheduleId"
      params={{ scheduleId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      {m.schedules_draft_open()}
    </Link>
  ),
  copy: {
    saving: m.schedules_draft_saving,
    saved: m.schedules_draft_saved,
    untitled: m.schedules_draft_untitled,
    title: m.schedules_draft_title,
    loadFailed: m.schedules_draft_load_failed,
    loading: m.schedules_draft_loading,
    create: m.schedules_draft_create,
    reloadTitle: m.schedules_draft_reload_title,
    reloadDescription: m.schedules_draft_reload_description,
    reload: m.schedules_draft_reload,
    discardSavedDescription: m.schedules_draft_discard_saved_description,
    saveEffect: m.schedules_draft_save_effect,
    createEffect: m.schedules_draft_create_effect,
  },
};

export function ScheduleDraftOwner(props: {
  draftIds: ReadonlyArray<string>;
  onGone: (draftId: string) => void;
  autoOpenIds?: ReadonlySet<string> | undefined;
  children: ReactNode;
  ref?: Ref<ScheduleDraftHandle> | undefined;
}) {
  return <DraftOwner ui={ui} {...props} />;
}
