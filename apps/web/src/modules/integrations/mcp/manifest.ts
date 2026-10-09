import type { IntegrationManifest } from "../manifest.ts";
import { McpLogo } from "./logo.tsx";

/** How people reach the server; the admin picks one per integration. */
export const MCP_AUTH = ["oauth", "token", "none", "shared"] as const;
export type McpAuth = (typeof MCP_AUTH)[number];

export const mcpAuthOf = (config: Readonly<Record<string, string>>): McpAuth =>
  MCP_AUTH.find((mode) => mode === config.auth) ?? "oauth";

/**
 * Any remote MCP server. Its tools are not known here: each integration lists
 * them from its server and offers only what an admin approved.
 */
export const mcpManifest = {
  kind: "mcp",
  name: "MCP server",
  description: "Tools from a remote Model Context Protocol server.",
  logo: McpLogo,
  adminFields: [
    {
      key: "url",
      label: "Server address",
      kind: "url",
      placeholder: "https://mcp.example.com/mcp",
      description: "Its Streamable HTTP endpoint. Older SSE servers work too.",
      required: true,
    },
    {
      key: "auth",
      label: "Sign-in",
      kind: "select",
      required: true,
      options: [
        { value: "oauth", label: "Each person signs in" },
        { value: "token", label: "Each person pastes a token" },
        { value: "none", label: "No sign-in" },
        { value: "shared", label: "One key for everyone, read-only" },
      ],
    },
    {
      key: "header",
      label: "Header",
      kind: "text",
      placeholder: "Authorization",
      description: "Where the token goes. Authorization sends it as a bearer token.",
      required: false,
      when: { key: "auth", values: ["token", "shared"] },
    },
    {
      key: "scopes",
      label: "Scopes",
      kind: "text",
      placeholder: "Leave empty to ask for what the server needs",
      required: false,
      when: { key: "auth", values: ["oauth"] },
    },
  ],
  oauth: {
    when: { key: "auth", values: ["oauth"] },
    setup: {
      // Each server signs in somewhere else, so there is no one console to name.
      console: null,
      steps: [
        { text: "Usually nothing to do: this app registers itself with the server’s sign-in." },
        {
          text: "If the sign-in only accepts registered apps, register one with the redirect URI above and paste its client ID and secret.",
        },
      ],
    },
  },
  apiKey: {
    noun: "a token",
    when: { key: "auth", values: ["token"] },
    fields: [{ key: "token", label: "Token", kind: "secret", required: true }],
    helpUrl: () => null,
  },
  sharedCredential: {
    fields: [{ key: "token", label: "Shared key", kind: "secret", required: true }],
    when: { key: "auth", values: ["shared"] },
  },
  toolSource: "catalog",
  tools: [],
  allowances: [],
  scope: null,
  knowledgeSource: false,
} satisfies IntegrationManifest;
