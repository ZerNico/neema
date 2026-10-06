import type { IntegrationManifest } from "../manifest.ts";
import { OutlineLogo } from "./logo.tsx";
import { OUTLINE_TOOLS } from "./tools.ts";

export const outlineManifest = {
  kind: "outline",
  name: "Outline",
  description: "Search, read and write documents in an Outline knowledge base.",
  logo: OutlineLogo,
  adminFields: [
    {
      key: "baseUrl",
      label: "Outline address",
      kind: "url",
      placeholder: "https://app.getoutline.com",
      description: "The address people open Outline at. Use your own domain when self-hosted.",
      required: true,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: "Outline’s application settings",
        url: (config) =>
          config.baseUrl ? `${config.baseUrl.replace(/\/+$/, "")}/settings/applications` : null,
      },
      steps: [
        { text: "Create an application with the redirect URI above as its callback URL." },
        { text: "Paste its client ID and secret below." },
      ],
    },
  },
  apiKey: {
    fields: [
      { key: "key", label: "API key", kind: "secret", placeholder: "ol_api_…", required: true },
    ],
    helpUrl: (config) => (config.baseUrl ? `${config.baseUrl.replace(/\/+$/, "")}/settings` : null),
  },
  tools: OUTLINE_TOOLS,
  allowances: [],
  scope: null,
  knowledgeSource: true,
} satisfies IntegrationManifest;
