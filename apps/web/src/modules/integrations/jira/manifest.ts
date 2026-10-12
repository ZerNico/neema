import type { IntegrationManifest } from "../manifest.ts";
import { JiraLogo } from "./logo.tsx";
import { JIRA_TOOLS } from "./tools.ts";

export const jiraManifest = {
  kind: "jira",
  name: "Jira",
  description:
    "Search and read Jira issues, create and edit them, comment, assign and move them along.",
  logo: JiraLogo,
  adminFields: [
    {
      key: "site",
      label: "Jira site",
      kind: "text",
      placeholder: "acme.atlassian.net",
      description: "Your Jira Cloud site.",
      required: true,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: "Atlassian developer console",
        url: () => "https://developer.atlassian.com/console/myapps/",
      },
      steps: [
        { text: "Create an OAuth 2.0 integration with Resource-level access." },
        {
          text: "Under Permissions, add the Jira API with these scopes:",
          values: ["read:jira-work", "write:jira-work", "read:jira-user"],
        },
        { text: "Under Authorization, add the redirect URI above as its callback URL." },
        { text: "Under Distribution, turn on sharing so others in your organization can connect." },
        { text: "Paste the client ID and secret from Settings below." },
      ],
    },
  },
  apiKey: {
    fields: [
      {
        key: "email",
        label: "Atlassian account email",
        kind: "email",
        placeholder: "you@example.com",
        required: true,
      },
      {
        key: "token",
        label: "API token",
        kind: "secret",
        description: "A token without scopes; Jira takes it together with your account's email.",
        required: true,
      },
    ],
    helpUrl: () => "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  sharedCredential: null,
  toolSource: "static",
  tools: JIRA_TOOLS,
  allowances: [],
  scope: { label: "Projects", noun: "project" },
  knowledgeSource: false,
} satisfies IntegrationManifest;
