import { defineDraftToolSchema } from "~/modules/drafts/tool-schema.ts";
import { DraftSettings } from "./draft-schema.ts";

const schema = defineDraftToolSchema({
  family: "agent-draft",
  toolNames: ["draft_agent", "read_agent_draft", "list_agent_options", "update_agent_draft"],
  extraOutcomes: ["options"],
  settings: DraftSettings,
});

export const AgentDraftToolName = schema.ToolName;
export type AgentDraftToolName = typeof AgentDraftToolName.Type;
export const AgentDraftActivityResult = schema.ActivityResult;
export type AgentDraftActivityResult = typeof AgentDraftActivityResult.Type;
export const AgentDraftToolEnvelope = schema.Envelope;
export const projectAgentDraftResult = schema.projectResult;
export const agentDraftFailureReason = schema.failureReason;
export const agentDraftResultOk = schema.resultOk;
export const redactAgentDraftPart = schema.redactPart;
