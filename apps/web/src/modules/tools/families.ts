/**
 * Every tool family. A tool group declares the family of the tools it
 * carries, the call's row stores it, and reload and branch read it back.
 * Kept alone so the database schema can name them without runtime code.
 */
export const TOOL_FAMILY_NAMES = [
  "agent-draft",
  "schedule-draft",
  "document",
  "project-file",
  "presentation",
  "spreadsheet",
  "word",
  "skill",
  "knowledge",
  "tool-file",
  "image",
  "custom",
  "integration",
  "desktop",
  "research",
  "ask",
  "map",
  "notify",
  "plan",
  "attachment",
  "history",
  "tool-load",
  "memory",
  "web",
] as const;
export type ToolFamily = (typeof TOOL_FAMILY_NAMES)[number];
