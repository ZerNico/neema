import { fieldValues } from "../fields.ts";
import type { IntegrationManifest } from "../manifest.ts";
import { McpLogo } from "./logo.tsx";

/** The ways in an admin may tick; several may stand side by side, like a public server with private extras. */
export const MCP_WAYS = ["oauth", "token", "anonymous"] as const;
/** How the server is reached without an account: as nobody, or with the admin's key. */
export const MCP_ANONYMOUS = ["open", "shared"] as const;

export interface McpWays {
  readonly oauth: boolean;
  readonly token: boolean;
  readonly anonymous: (typeof MCP_ANONYMOUS)[number] | "off";
}

export const mcpWaysOf = (config: Readonly<Record<string, string>>): McpWays => {
  const ticked = fieldValues(config.ways ?? "oauth");
  return {
    oauth: ticked.includes("oauth"),
    token: ticked.includes("token"),
    anonymous: ticked.includes("anonymous")
      ? (MCP_ANONYMOUS.find((value) => value === config.anonymous) ?? "open")
      : "off",
  };
};

const OAUTH = { key: "ways", values: ["oauth"] };
const TOKEN = { key: "ways", values: ["token"] };
const ANONYMOUS = { key: "ways", values: ["anonymous"] };
const SHARED = { key: "anonymous", values: ["shared"] };

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
      key: "ways",
      label: "How people connect",
      kind: "choices",
      required: true,
      options: [
        { value: "oauth", label: "Sign in", description: "With their own account on the server." },
        { value: "token", label: "Personal token", description: "Pasted from their own account." },
        {
          value: "anonymous",
          label: "Without an account",
          description: "For servers anyone can use.",
        },
      ],
    },
    {
      key: "anonymous",
      label: "Without an account",
      kind: "choice",
      required: true,
      when: ANONYMOUS,
      options: [
        { value: "open", label: "No key", description: "The server needs nothing." },
        {
          value: "shared",
          label: "One shared key",
          description: "Everyone uses your key, so chats only read.",
        },
      ],
    },
    {
      key: "header",
      label: "Header",
      kind: "text",
      placeholder: "Authorization",
      description: "Where the token goes. Authorization sends it as a bearer token.",
      required: false,
      when: [TOKEN, SHARED],
    },
    {
      key: "scopes",
      label: "Scopes",
      kind: "text",
      placeholder: "Leave empty to ask for what the server needs",
      required: false,
      when: OAUTH,
    },
  ],
  oauth: {
    when: OAUTH,
    optionalClient: true,
    setup: {
      // Each server signs in somewhere else, so there is no one console to name.
      console: null,
      steps: [
        {
          text: "Register the app with this redirect URI, then paste its client ID and secret.",
        },
      ],
    },
  },
  apiKey: {
    noun: "a token",
    when: TOKEN,
    fields: [{ key: "token", label: "Token", kind: "secret", required: true }],
    helpUrl: () => null,
  },
  sharedCredential: {
    fields: [{ key: "token", label: "Shared key", kind: "secret", required: true }],
    when: SHARED,
  },
  toolSource: "catalog",
  tools: [],
  allowances: [],
  scope: null,
  knowledgeSource: false,
} satisfies IntegrationManifest;
