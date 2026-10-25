export const CAPABILITY_KEYS = [
  "agentsUse",
  "agentsCreate",
  "knowledgeUse",
  "knowledgeCreate",
  "skillsUse",
  "skillsCreate",
  "projectsUse",
  "projectsCreate",
  "schedules",
  "webSearch",
  "deepResearch",
  "memory",
  "documents",
  "customTools",
  "work",
  "attachments",
  "mcp",
  "apiKeys",
  "mcpServers",
] as const;

export type Capability = (typeof CAPABILITY_KEYS)[number];
export type Capabilities = Record<Capability, boolean>;

export const ALL_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITY_KEYS.map((key) => [key, true]),
) as Capabilities;

/**
 * Each Create and the Use it requires. Every write refuses Create without Use
 * and a check constraint holds stored rows to it, so readers take each key as
 * it is and never infer one from another.
 */
export const CREATE_REQUIRES_USE = [
  ["agentsCreate", "agentsUse"],
  ["knowledgeCreate", "knowledgeUse"],
  ["skillsCreate", "skillsUse"],
  ["projectsCreate", "projectsUse"],
] as const satisfies ReadonlyArray<readonly [Capability, Capability]>;

export function validCapabilities(value: Capabilities): boolean {
  return CREATE_REQUIRES_USE.every(([create, use]) => !value[create] || value[use]);
}
