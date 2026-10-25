import { m } from "~/paraglide/messages.js";
import type { UnavailableAgentDependency } from "~/db/schema/agents.ts";

export type AgentUnavailable = Omit<UnavailableAgentDependency, "id">;

type Lines = {
  named: (inputs: { name: string }) => string;
  unnamed: (inputs: { count: number }) => string;
};

const LINES: Record<AgentUnavailable["kind"], Lines> = {
  collection: {
    named: m.chat_agent_missing_collection_named,
    unnamed: m.chat_agent_missing_collection_unnamed,
  },
  skill: { named: m.chat_agent_missing_skill_named, unnamed: m.chat_agent_missing_skill_unnamed },
  customTool: {
    named: m.chat_agent_missing_tool_named,
    unnamed: m.chat_agent_missing_tool_unnamed,
  },
  integration: {
    named: m.chat_agent_missing_integration_named,
    unnamed: m.chat_agent_missing_integration_unnamed,
  },
};

/**
 * The lines an answer shows for what its agent brought and it ran without.
 * Named ones say their name; the rest of a kind are counted, since the
 * reader may no longer see what they were called.
 */
export function agentUnavailableLines(items: ReadonlyArray<AgentUnavailable>): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(LINES) as Array<AgentUnavailable["kind"]>) {
    const { named, unnamed } = LINES[kind];
    const ofKind = items.filter((item) => item.kind === kind);
    for (const item of ofKind) if (item.name) lines.push(named({ name: item.name }));
    const count = ofKind.filter((item) => !item.name).length;
    if (count > 0) lines.push(unnamed({ count }));
  }
  return lines;
}
