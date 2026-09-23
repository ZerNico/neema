export const CAPABILITY_KEYS = [
  "agentsUse",
  "agentsCreate",
  "knowledgeUse",
  "knowledgeCreate",
  "skillsUse",
  "skillsCreate",
  "schedules",
  "webSearch",
  "deepResearch",
  "memory",
  "documents",
  "customTools",
  "work",
  "attachments",
] as const;

export type Capability = (typeof CAPABILITY_KEYS)[number];
export type Capabilities = Record<Capability, boolean>;

export const ALL_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITY_KEYS.map((key) => [key, true]),
) as Capabilities;

export function validCapabilities(value: Capabilities): boolean {
  return (
    (!value.agentsCreate || value.agentsUse) &&
    (!value.knowledgeCreate || value.knowledgeUse) &&
    (!value.skillsCreate || value.skillsUse)
  );
}

export function effectiveCapabilities(value: Capabilities): Capabilities {
  return {
    ...value,
    agentsUse: value.agentsUse || value.agentsCreate,
    knowledgeUse: value.knowledgeUse || value.knowledgeCreate,
    skillsUse: value.skillsUse || value.skillsCreate,
  };
}
