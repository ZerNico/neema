import type { IntegrationManifest } from "../manifest.ts";
import { JiraLogo } from "./logo.tsx";
import { JIRA_TOOLS } from "./tools.ts";

export const jiraManifest = {
  id: "jira",
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
    setup:
      "In the Atlassian developer console (developer.atlassian.com/console/myapps), create an OAuth 2.0 integration. Under Permissions add the Jira API with the scopes read:jira-work, write:jira-work and read:jira-user; under Authorization add this redirect URI; under Distribution turn on sharing so others in your organization can connect. Paste its client ID and secret here.",
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
  tools: JIRA_TOOLS,
  allowances: [],
  knowledgeSource: false,
} satisfies IntegrationManifest;
