import { getLocale, type Locale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
/**
 * What a connected app may ask for. Each tool names the scope it needs, so a
 * person who leaves one out at consent never sees those tools.
 */
export const MCP_SCOPES = [
  "chats:read",
  "chats:write",
  "knowledge:read",
  "documents:read",
  "documents:write",
  "memory:read",
  "memory:write",
  "skills:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export const isMcpScope = (scope: string): scope is McpScope =>
  (MCP_SCOPES as ReadonlyArray<string>).includes(scope);

/** Lets an app stay connected past its hour-long access token. */
export const OFFLINE_ACCESS = "offline_access";

export const MCP_SCOPE_LABELS: Record<McpScope, () => string> = {
  "chats:read": m.mcp_server_scope_chats_read,
  "chats:write": m.mcp_server_scope_chats_write,
  "knowledge:read": m.mcp_server_scope_knowledge_read,
  "documents:read": m.mcp_server_scope_documents_read,
  "documents:write": m.mcp_server_scope_documents_write,
  "memory:read": m.mcp_server_scope_memory_read,
  "memory:write": m.mcp_server_scope_memory_write,
  "skills:read": m.mcp_server_scope_skills_read,
};

/** The MCP endpoint, which is also the resource its tokens are bound to. */
export const MCP_PATH = "/api/mcp";

const AREAS = {
  chats: m.mcp_server_area_chats,
  knowledge: m.mcp_server_area_knowledge,
  documents: m.mcp_server_area_documents,
  memory: m.mcp_server_area_memory,
  skills: m.mcp_server_area_skills,
} as const;

/** A granted set in one short line: what an app may change, then what it may only see. */
export const accessSummary = (granted: ReadonlyArray<string>, locale: Locale = getLocale()) => {
  const options = { locale };
  if (MCP_SCOPES.every((scope) => granted.includes(scope)))
    return m.mcp_server_access_full({}, options);
  const areas = Object.keys(AREAS) as Array<keyof typeof AREAS>;
  const changes = areas.filter((area) => granted.includes(`${area}:write`));
  const sees = areas.filter((area) => !changes.includes(area) && granted.includes(`${area}:read`));
  // British English joins without the serial comma, as this line always has.
  const list = (picked: ReadonlyArray<keyof typeof AREAS>) =>
    new Intl.ListFormat(locale === "en" ? "en-GB" : locale, { type: "conjunction" }).format(
      picked.map((area) => AREAS[area]({}, options)),
    );
  if (changes.length && sees.length)
    return m.mcp_server_access_change_see({ changes: list(changes), sees: list(sees) }, options);
  if (changes.length) return m.mcp_server_access_change({ areas: list(changes) }, options);
  return sees.length ? m.mcp_server_access_see({ areas: list(sees) }, options) : "";
};
