import type { UnavailableAgentDependency } from "~/db/schema/agents.ts";

export type AgentUnavailable = Omit<UnavailableAgentDependency, "id">;

const NOUNS: Record<AgentUnavailable["kind"], readonly [string, string]> = {
  collection: ["collection", "collections"],
  skill: ["skill", "skills"],
  customTool: ["tool", "tools"],
  integration: ["integration", "integrations"],
};

/**
 * The lines an answer shows for what its agent brought and it ran without.
 * Named ones say their name; the rest of a kind are counted, since the
 * reader may no longer see what they were called.
 */
export function agentUnavailableLines(items: ReadonlyArray<AgentUnavailable>): string[] {
  const lines: string[] = [];
  for (const kind of Object.keys(NOUNS) as Array<AgentUnavailable["kind"]>) {
    const [one, many] = NOUNS[kind];
    const ofKind = items.filter((item) => item.kind === kind);
    for (const item of ofKind)
      if (item.name) lines.push(`The agent’s ${one} “${item.name}” is no longer available`);
    const unnamed = ofKind.filter((item) => !item.name).length;
    if (unnamed === 1) lines.push(`One of the agent’s ${many} is no longer available`);
    else if (unnamed > 1) lines.push(`${unnamed} of the agent’s ${many} are no longer available`);
  }
  return lines;
}
