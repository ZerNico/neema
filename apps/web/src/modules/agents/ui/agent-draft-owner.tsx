import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type { ReactNode, Ref } from "react";
import {
  DraftOwner,
  type DraftHandle,
  type DraftKindUi,
} from "~/modules/drafts/ui/draft-owner.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { useAgentDraft } from "../client/use-agent-draft.ts";
import type { DraftSettings } from "../draft-schema.ts";
import { AgentSettingsFields } from "./agent-settings-fields.tsx";

export type AgentDraftHandle = DraftHandle;

const ui: DraftKindUi<DraftSettings> = {
  kind: "agent",
  noun: "agent",
  Noun: "Agent",
  icon: PencilEdit02Icon,
  useController: useAgentDraft,
  labels: {
    name: "Name",
    description: "Description",
    instructions: "Instructions",
    icon: "Icon",
    modelId: "Preferred model",
    searchEnabled: "Web search",
    planEnabled: "Working checklist",
    starters: "Conversation starters",
    collectionIds: "Collections",
    skillIds: "Skills",
    customToolIds: "Custom tools",
    integrationIds: "Integrations",
  },
  Fields: AgentSettingsFields,
  targetLink: (agentId) => (
    <Link
      to="/agents/$agentId"
      params={{ agentId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      Open in editor
    </Link>
  ),
  targetActions: (agentId) => (
    <Link
      to="/"
      search={{ agent: agentId }}
      className={buttonVariants({ size: "sm", variant: "outline" })}
    >
      Start chat
    </Link>
  ),
  copy: {
    saveEffect: "Saving changes affects future replies in chats using this agent.",
    createEffect: "The agent is created only when you choose Create agent.",
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
