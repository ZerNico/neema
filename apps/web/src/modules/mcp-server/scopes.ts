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

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "chats:read": "Read and search your chats",
  "chats:write": "Send messages and start chats with your agents",
  "knowledge:read": "Search your knowledge",
  "documents:read": "Read your documents",
  "documents:write": "Edit your documents",
  "memory:read": "Read your memories",
  "memory:write": "Save and delete memories",
  "skills:read": "Use your skills",
};

/** The MCP endpoint, which is also the resource its tokens are bound to. */
export const MCP_PATH = "/api/mcp";

const AREAS = ["chats", "knowledge", "documents", "memory", "skills"] as const;

const list = (words: ReadonlyArray<string>) =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");

/** A granted set in one short line: what an app may change, then what it may only see. */
export const accessSummary = (granted: ReadonlyArray<string>) => {
  if (MCP_SCOPES.every((scope) => granted.includes(scope))) return "Full access";
  const changes = AREAS.filter((area) => granted.includes(`${area}:write`));
  const sees = AREAS.filter((area) => !changes.includes(area) && granted.includes(`${area}:read`));
  return [
    changes.length ? `Can change ${list(changes)}` : "",
    sees.length ? `${changes.length ? "can" : "Can"} see ${list(sees)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
};
