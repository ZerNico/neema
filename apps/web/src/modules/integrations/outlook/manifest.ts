import type { IntegrationManifest } from "../manifest.ts";
import { OutlookLogo } from "./logo.tsx";
import { OUTLOOK_TOOLS } from "./tools.ts";

export const outlookManifest = {
  id: "outlook",
  name: "Outlook",
  description:
    "Search and read Outlook mail, check calendars, draft and send mail, and create events.",
  logo: OutlookLogo,
  adminFields: [
    {
      key: "tenant",
      label: "Tenant",
      kind: "text",
      placeholder: "organizations",
      description:
        "Your directory (tenant) ID or domain, to admit only your organization. Leave empty for any work or school account.",
      required: false,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: "Microsoft Entra admin center",
        url: () =>
          "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      },
      steps: [
        {
          text: "Under App registrations, register an application with the redirect URI above as a Web redirect URI.",
        },
        {
          text: "Under API permissions, add these delegated Microsoft Graph permissions:",
          values: [
            "offline_access",
            "User.Read",
            "Mail.ReadWrite",
            "Mail.Send",
            "Calendars.ReadWrite",
          ],
        },
        { text: "Under Certificates & secrets, create a client secret." },
        { text: "Paste the application (client) ID and the secret’s value below." },
      ],
    },
  },
  apiKey: null,
  tools: OUTLOOK_TOOLS,
  allowances: [
    {
      id: "send",
      label: "Send mail",
      description: "Send mail and drafts to these addresses",
      tools: ["send_mail"],
      targets: "email",
      cap: 3,
    },
    {
      id: "invite",
      label: "Invite people",
      description: "Create events that invite these addresses",
      tools: ["create_event"],
      targets: "email",
      cap: 3,
    },
  ],
  knowledgeSource: false,
} satisfies IntegrationManifest;
