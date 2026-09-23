import { Schema, Struct } from "effect";
import {
  AGENT_LIMITS,
  AgentInstructions,
  AgentName,
  AgentSettings,
  AgentResourceIds,
  AgentStarter,
  type AgentDetail,
} from "./schema.ts";

/** Working input retains unfinished text; only the explicit Save validates an agent. */
export const DraftSettings = Schema.Struct({
  ...AgentSettings.fields,
  name: AgentName,
  instructions: AgentInstructions,
  starters: Schema.Array(AgentStarter).check(Schema.isMaxLength(AGENT_LIMITS.maxStarters)),
  skillIds: AgentResourceIds,
  customToolIds: AgentResourceIds,
});
export type DraftSettings = typeof DraftSettings.Type;
export const AgentDraftPatch = DraftSettings.mapFields(Struct.map(Schema.optionalKey));
export type AgentDraftPatch = typeof AgentDraftPatch.Type;
export const EMPTY_AGENT_DRAFT: DraftSettings = {
  name: "",
  description: "",
  icon: "robot",
  instructions: "",
  modelId: null,
  searchEnabled: false,
  planEnabled: false,
  starters: [],
  collectionIds: [],
  skillIds: [],
  customToolIds: [],
};
export const agentDetailToSettings = (agent: AgentDetail): DraftSettings => ({
  name: agent.name,
  description: agent.description,
  icon: agent.icon as DraftSettings["icon"],
  instructions: agent.instructions,
  modelId: agent.modelId,
  searchEnabled: agent.searchEnabled,
  planEnabled: agent.planEnabled,
  starters: [...agent.starters],
  collectionIds: agent.collections.map(({ id }) => id),
  skillIds: (agent.skills ?? []).map(({ id }) => id),
  customToolIds: (agent.customTools ?? []).map(({ id }) => id),
});

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const AgentDraftIdInput = Schema.Struct({ draftId: ResourceId });
export const AgentDraftRevisionInput = Schema.Struct({
  ...AgentDraftIdInput.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type AgentDraftRevisionInput = typeof AgentDraftRevisionInput.Type;
/** Opening is per conversation; the draft it resolves to may already exist. */
export const OpenAgentDraftInput = Schema.Struct({
  conversationId: ResourceId,
  agentId: Schema.optionalKey(ResourceId),
  changes: Schema.optionalKey(AgentDraftPatch),
});
export type OpenAgentDraftInput = typeof OpenAgentDraftInput.Type;
export interface OpenAgentDraftResult {
  outcome: "drafted" | "read";
  draft: AgentDraft;
}
export const PatchAgentDraftInput = Schema.Struct({
  ...AgentDraftRevisionInput.fields,
  changes: AgentDraftPatch,
});
export type PatchAgentDraftInput = typeof PatchAgentDraftInput.Type;

export interface AgentDraft {
  id: string;
  conversationId: string;
  kind: "agent";
  settings: DraftSettings;
  revision: number;
  targetId: string | null;
  targetRevision: number | null;
  savedDraftRevision: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface PatchAgentDraftResult {
  outcome: "updated" | "unchanged" | "conflict";
  draft: AgentDraft;
}
export type SaveAgentDraftResult =
  | { outcome: "saved"; draft: AgentDraft; agentId: string; configRevision: number }
  | { outcome: "conflict" | "agent_changed" | "agent_unavailable"; draft: AgentDraft }
  | { outcome: "invalid"; draft: AgentDraft; reason: string };
export interface ReloadAgentDraftResult {
  outcome: "reloaded" | "conflict" | "agent_unavailable" | "no_target";
  draft: AgentDraft;
}

export { DraftNotAvailable, DraftRejected } from "~/modules/drafts/draft-schema.ts";
