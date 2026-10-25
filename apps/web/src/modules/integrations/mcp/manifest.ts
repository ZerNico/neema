import { m } from "~/paraglide/messages.js";
import { localized, verbatim } from "~/i18n/localized.ts";
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
  /** Used without an account, it is on for everyone who may use it, without a press. */
  readonly everyone: boolean;
}

export const mcpWaysOf = (config: Readonly<Record<string, string>>): McpWays => {
  const ticked = fieldValues(config.ways ?? "oauth");
  const anonymous = ticked.includes("anonymous");
  return {
    oauth: ticked.includes("oauth"),
    token: ticked.includes("token"),
    anonymous: anonymous
      ? (MCP_ANONYMOUS.find((value) => value === config.anonymous) ?? "open")
      : "off",
    everyone: anonymous && config.everyone === "everyone",
  };
};

/**
 * A server a person added for themselves: every request, its own address
 * included, must reach a public address. Set by the server, never a field.
 */
export const reachesPublicOnly = (config: Readonly<Record<string, string>>) =>
  config.reach === "public";

const OAUTH = { key: "ways", values: ["oauth"] };
const TOKEN = { key: "ways", values: ["token"] };
const ANONYMOUS = { key: "ways", values: ["anonymous"] };
const SHARED = { key: "anonymous", values: ["shared"] };

/**
 * Any remote MCP server. Its tools are not known here: each integration
 * offers what its server lists to each account.
 */
export const mcpManifest = {
  kind: "mcp",
  name: "MCP server",
  description: localized(m.integrations_mcp_description),
  logo: McpLogo,
  category: null,
  adminFields: [
    {
      key: "url",
      label: localized(m.integrations_mcp_url_label),
      kind: "url",
      placeholder: verbatim("https://mcp.example.com/mcp"),
      description: localized(m.integrations_mcp_url_description),
      required: true,
    },
    {
      key: "ways",
      label: localized(m.integrations_mcp_ways_label),
      kind: "choices",
      required: true,
      options: [
        {
          value: "oauth",
          label: localized(m.integrations_mcp_way_oauth),
          description: localized(m.integrations_mcp_way_oauth_description),
        },
        {
          value: "token",
          label: localized(m.integrations_mcp_way_token),
          description: localized(m.integrations_mcp_way_token_description),
        },
        {
          value: "anonymous",
          label: localized(m.integrations_mcp_way_anonymous),
          description: localized(m.integrations_mcp_way_anonymous_description),
        },
      ],
    },
    {
      key: "anonymous",
      label: localized(m.integrations_mcp_anonymous_label),
      kind: "choice",
      required: true,
      when: ANONYMOUS,
      options: [
        {
          value: "open",
          label: localized(m.integrations_mcp_anonymous_open),
          description: localized(m.integrations_mcp_anonymous_open_description),
        },
        {
          value: "shared",
          label: localized(m.integrations_mcp_anonymous_shared),
          description: localized(m.integrations_mcp_anonymous_shared_description),
        },
      ],
    },
    {
      key: "everyone",
      label: localized(m.integrations_mcp_everyone_label),
      kind: "choice",
      // Unset reads as each person, the first option.
      required: true,
      when: ANONYMOUS,
      options: [
        {
          value: "person",
          label: localized(m.integrations_mcp_everyone_person),
          description: localized(m.integrations_mcp_everyone_person_description),
        },
        {
          value: "everyone",
          label: localized(m.integrations_mcp_everyone_all),
          description: localized(m.integrations_mcp_everyone_all_description),
        },
      ],
    },
    {
      key: "header",
      label: localized(m.integrations_mcp_header_label),
      kind: "text",
      placeholder: verbatim("Authorization"),
      description: localized(m.integrations_mcp_header_description),
      required: false,
      when: [TOKEN, SHARED],
    },
    {
      key: "scopes",
      label: localized(m.integrations_mcp_scopes_label),
      kind: "text",
      placeholder: localized(m.integrations_mcp_scopes_placeholder),
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
      steps: [{ text: localized(m.integrations_mcp_step_register) }],
    },
  },
  apiKey: {
    noun: localized(m.integrations_mcp_api_key_noun),
    when: TOKEN,
    fields: [
      {
        key: "token",
        label: localized(m.integrations_mcp_token_label),
        kind: "secret",
        required: true,
      },
    ],
    helpUrl: () => null,
  },
  sharedCredential: {
    fields: [
      {
        key: "token",
        label: localized(m.integrations_mcp_shared_key_label),
        kind: "secret",
        required: true,
      },
    ],
    when: SHARED,
  },
  toolSource: "listed",
  tools: [],
  allowances: [],
  scope: null,
  knowledgeSource: false,
} satisfies IntegrationManifest;
