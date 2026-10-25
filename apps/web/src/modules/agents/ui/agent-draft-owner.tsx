import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import {
  DraftOwner,
  type DraftHandle,
  type DraftKindUi,
} from "~/modules/drafts/ui/draft-owner.tsx";
import { m } from "~/paraglide/messages.js";
import { buttonVariants } from "~/ui/primitives/button";
import { useAgentDraft } from "../client/use-agent-draft.ts";
import type { DraftSettings } from "../draft-schema.ts";
import { AgentSettingsFields } from "./agent-settings-fields.tsx";

export type AgentDraftHandle = DraftHandle;

const ui: DraftKindUi<DraftSettings> = {
  kind: "agent",
  icon: PencilEdit02Icon,
  useController: useAgentDraft,
  labels: {
    name: m.agents_field_name,
    description: m.agents_field_description,
    instructions: m.agents_field_instructions,
    icon: m.agents_field_icon,
    modelId: m.agents_field_model,
    imageModelId: m.agents_field_image_model,
    searchEnabled: m.agents_field_web_search,
    planEnabled: m.agents_field_checklist,
    starters: m.agents_field_starters,
    collectionIds: m.agents_field_collections,
    skillIds: m.agents_field_skills,
    customToolIds: m.agents_field_custom_tools,
    integrationIds: m.agents_field_integrations,
  },
  Fields: AgentSettingsFields,
  targetLink: (agentId) => (
    <Link
      to="/agents/$agentId"
      params={{ agentId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      {m.agents_draft_open_editor()}
    </Link>
  ),
  targetActions: (agentId) => (
    <Link
      to="/"
      search={{ agent: agentId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      {m.agents_start_chat()}
    </Link>
  ),
  copy: {
    saving: m.agents_draft_saving,
    saved: m.agents_draft_saved,
    untitled: m.agents_draft_untitled,
    title: m.agents_draft_title,
    loadFailed: m.agents_draft_load_failed,
    loading: m.agents_draft_loading,
    create: m.agents_draft_create,
    reloadTitle: m.agents_draft_reload_title,
    reloadDescription: m.agents_draft_reload_description,
    reload: m.agents_draft_reload,
    discardSavedDescription: m.agents_draft_discard_saved_description,
    saveEffect: m.agents_draft_save_effect,
    createEffect: m.agents_draft_create_effect,
  },
};

export function AgentDraftOwner(props: {
  draftIds: ReadonlyArray<string>;
  onGone: (draftId: string) => void;
  autoOpenIds?: ReadonlySet<string> | undefined;
  children: ReactNode;
  ref?: Ref<AgentDraftHandle> | undefined;
}) {
  return <DraftOwner ui={ui} {...props} />;
}
