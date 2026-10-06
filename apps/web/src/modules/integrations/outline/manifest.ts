import type { IntegrationManifest } from "../manifest.ts";
import { OutlineLogo } from "./logo.tsx";
import { OUTLINE_TOOLS } from "./tools.ts";

export const outlineManifest = {
  id: "outline",
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
    setup:
      "In Outline, open Settings → Applications, create an application with this redirect URI, and paste its client ID and secret here.",
  },
  apiKey: {
    label: "API key",
    placeholder: "ol_api_…",
    helpUrl: (config) => (config.baseUrl ? `${config.baseUrl.replace(/\/+$/, "")}/settings` : null),
  },
  tools: OUTLINE_TOOLS,
  allowances: [],
  knowledgeSource: true,
} satisfies IntegrationManifest;
