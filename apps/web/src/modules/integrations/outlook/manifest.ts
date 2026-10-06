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
    setup:
      "In the Microsoft Entra admin center, register an application (App registrations → New registration) with this redirect URI as a Web platform URI. Add the delegated Microsoft Graph permissions offline_access, User.Read, Mail.ReadWrite, Mail.Send and Calendars.ReadWrite, create a client secret under Certificates & secrets, and paste the application (client) ID and the secret's value here.",
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
