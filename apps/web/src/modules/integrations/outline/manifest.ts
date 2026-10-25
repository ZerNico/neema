import { localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import type { IntegrationManifest } from "../manifest.ts";
import { OutlineLogo } from "./logo.tsx";
import { OUTLINE_TOOLS } from "./tools.ts";

export const outlineManifest = {
  kind: "outline",
  name: "Outline",
  description: localized(m.integrations_outline_description),
  logo: OutlineLogo,
  category: "docs",
  adminFields: [
    {
      key: "baseUrl",
      label: localized(m.integrations_outline_base_url_label),
      kind: "url",
      placeholder: verbatim("https://app.getoutline.com"),
      description: localized(m.integrations_outline_base_url_description),
      required: true,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: localized(m.integrations_outline_console),
        url: (config) =>
          config.baseUrl ? `${config.baseUrl.replace(/\/+$/, "")}/settings/applications` : null,
      },
      steps: [
        { text: localized(m.integrations_outline_step_create) },
        { text: localized(m.integrations_outline_step_paste) },
      ],
    },
  },
  apiKey: {
    fields: [
      {
        key: "key",
        label: localized(m.integrations_outline_api_key),
        kind: "secret",
        placeholder: verbatim("ol_api_…"),
        required: true,
      },
    ],
    helpUrl: (config) => (config.baseUrl ? `${config.baseUrl.replace(/\/+$/, "")}/settings` : null),
  },
  sharedCredential: null,
  toolSource: "static",
  tools: OUTLINE_TOOLS,
  allowances: [],
  scope: null,
  knowledgeSource: true,
} satisfies IntegrationManifest;
