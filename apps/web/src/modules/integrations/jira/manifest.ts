import { localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import type { IntegrationManifest } from "../manifest.ts";
import { JiraLogo } from "./logo.tsx";
import { JIRA_TOOLS } from "./tools.ts";

export const jiraManifest = {
  kind: "jira",
  name: "Jira",
  description: localized(m.integrations_jira_description),
  logo: JiraLogo,
  category: "projects",
  adminFields: [
    {
      key: "site",
      label: localized(m.integrations_jira_site_label),
      kind: "text",
      placeholder: verbatim("acme.atlassian.net"),
      description: localized(m.integrations_jira_site_description),
      required: true,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: localized(m.integrations_jira_console),
        url: () => "https://developer.atlassian.com/console/myapps/",
      },
      steps: [
        { text: localized(m.integrations_jira_step_create) },
        {
          text: localized(m.integrations_jira_step_permissions),
          values: ["read:jira-work", "write:jira-work", "read:jira-user"],
        },
        { text: localized(m.integrations_jira_step_authorization) },
        { text: localized(m.integrations_jira_step_distribution) },
        { text: localized(m.integrations_jira_step_paste) },
      ],
    },
  },
  apiKey: {
    fields: [
      {
        key: "email",
        label: localized(m.integrations_jira_email_label),
        kind: "email",
        placeholder: verbatim("you@example.com"),
        required: true,
      },
      {
        key: "token",
        label: localized(m.integrations_jira_token_label),
        kind: "secret",
        description: localized(m.integrations_jira_token_description),
        required: true,
      },
    ],
    helpUrl: () => "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  sharedCredential: null,
  toolSource: "static",
  tools: JIRA_TOOLS,
  allowances: [],
  scope: {
    label: localized(m.integrations_jira_scope_label),
    noun: localized(m.integrations_jira_scope_noun),
    plural: localized(m.integrations_jira_scope_plural),
  },
  knowledgeSource: false,
} satisfies IntegrationManifest;
