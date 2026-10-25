import { m } from "~/paraglide/messages.js";

/**
 * The unsent chat request that starts agent authoring. It is the person's own
 * message, so it is in their language.
 */
export const agentAuthoringRequest = (agentId: string | null = null) =>
  agentId
    ? m.agents_authoring_request_edit({ link: `/agents/${encodeURIComponent(agentId)}` })
    : m.agents_authoring_request_create();

export const readChatPrefill = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2_000 ? value : null;
