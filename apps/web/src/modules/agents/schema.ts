import { Schema } from "effect";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { EntityId } from "~/entity-id.ts";

export const AGENT_LIMITS = { maxPerUser: 100, maxInstructions: 20_000, maxStarters: 4 } as const;
export const AgentIcon = Schema.Literals([
  "robot",
  "sparkles",
  "code",
  "book",
  "search",
  "pen",
  "chart",
  "briefcase",
]);
export type AgentIcon = typeof AgentIcon.Type;
export const AgentIdInput = Schema.Struct({ agentId: EntityId });
export const AgentName = Schema.String.check(Schema.isMaxLength(120));
export const AgentInstructions = Schema.String.check(
  Schema.isMaxLength(AGENT_LIMITS.maxInstructions),
);
export const AgentStarter = Schema.String.check(Schema.isMaxLength(200));
export const AgentResourceIds = Schema.Array(EntityId).check(Schema.isMaxLength(20));
export const AgentSettings = Schema.Struct({
  name: AgentName.check(Schema.isMinLength(1, { message: "Enter a name." })),
  description: Schema.String.check(Schema.isMaxLength(500)),
  icon: AgentIcon,
  instructions: AgentInstructions.check(
    Schema.isMinLength(1, { message: "Enter the instructions." }),
  ),
  modelId: Schema.NullOr(EntityId),
  /** Preferred image model; absent keeps what is saved, null leaves it to each chat. */
  imageModelId: Schema.optionalKey(Schema.NullOr(EntityId)),
  searchEnabled: Schema.Boolean,
  planEnabled: Schema.Boolean,
  starters: Schema.Array(AgentStarter.check(Schema.isMinLength(1))).check(
    Schema.isMaxLength(AGENT_LIMITS.maxStarters),
  ),
  skillIds: Schema.optional(AgentResourceIds),
  customToolIds: Schema.optional(AgentResourceIds),
  /**
   * Services the agent is meant to use. They run with each sender's own
   * connection; a sender without one simply is not offered them.
   */
  integrationIds: Schema.optional(AgentResourceIds),
  collectionIds: Schema.Array(EntityId).check(
    Schema.isMaxLength(KNOWLEDGE_LIMITS.maxCollectionsPerSelection),
  ),
});
export type AgentSettings = typeof AgentSettings.Type;
export const UpdateAgentInput = Schema.Struct({
  ...AgentIdInput.fields,
  ...AgentSettings.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type UpdateAgentInput = typeof UpdateAgentInput.Type;
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  icon: string;
  audience: "private" | "instance";
  configRevision: number;
  canEdit: boolean;
  ownerName: string | null;
  updatedAt: string;
}
export interface AgentDetail extends AgentSelectionDetail {
  instructions: string;
}

/** Configuration metadata intentionally visible to shared recipients. */
export interface AgentSelectionDetail extends AgentSummary {
  modelId: string | null;
  imageModelId?: string | null;
  searchEnabled: boolean;
  planEnabled: boolean;
  starters: ReadonlyArray<string>;
  model: { id: string; name: string | null; available: boolean } | null;
  collections: ReadonlyArray<{ id: string; name: string | null; available: boolean }>;
  skills?: ReadonlyArray<{ id: string; name: string | null; available: boolean }>;
  customTools?: ReadonlyArray<{ id: string; name: string | null; available: boolean }>;
  integrations?: ReadonlyArray<{ id: string; name: string | null; available: boolean }>;
}
