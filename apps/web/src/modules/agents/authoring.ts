export const agentAuthoringRequest = (agentId: string | null = null) =>
  agentId
    ? `Help me improve [this agent](/agents/${encodeURIComponent(agentId)}). Ask what I’d like to change, then prepare a draft for me to review before saving.`
    : "Help me create an agent. Find out what I want it to help with, ask any useful follow-up questions, and prepare its instructions and settings for me to review before saving.";

export const readChatPrefill = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2_000 ? value : null;
