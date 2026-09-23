import type { IntegrationManifest } from "../manifest.ts";
import { OutlineLogo } from "./logo.tsx";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const quoted = (value: unknown) => {
  const found = text(value);
  return found ? `“${found.length > 80 ? `${found.slice(0, 79)}…` : found}”` : null;
};

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
  tools: [
    {
      name: "search",
      title: "Search documents",
      label: "Searched Outline",
      access: "read",
      summarize: (args) => quoted(args.query),
    },
    {
      name: "read_document",
      title: "Read a document",
      label: "Read an Outline document",
      access: "read",
      summarize: (args) => text(args.id),
    },
    {
      name: "list",
      title: "Browse collections and pages",
      label: "Browsed Outline",
      access: "read",
      summarize: () => null,
    },
    {
      name: "create_document",
      title: "Create documents",
      label: "Create an Outline document",
      access: "write",
      summarize: (args) => quoted(args.title),
    },
    {
      name: "update_document",
      title: "Update documents",
      label: "Update an Outline document",
      access: "write",
      summarize: (args) => quoted(args.title) ?? text(args.id),
    },
  ],
  knowledgeSource: true,
} satisfies IntegrationManifest;
