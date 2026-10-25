import { localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import type { IntegrationManifest } from "../manifest.ts";
import { OutlookLogo } from "./logo.tsx";
import { OUTLOOK_TOOLS } from "./tools.ts";

export const outlookManifest = {
  kind: "outlook",
  name: "Outlook",
  description: localized(m.integrations_outlook_description),
  logo: OutlookLogo,
  category: "productivity",
  adminFields: [
    {
      key: "tenant",
      label: localized(m.integrations_outlook_tenant_label),
      kind: "text",
      placeholder: verbatim("organizations"),
      description: localized(m.integrations_outlook_tenant_description),
      required: false,
    },
  ],
  oauth: {
    setup: {
      console: {
        label: localized(m.integrations_outlook_console),
        url: () =>
          "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      },
      steps: [
        { text: localized(m.integrations_outlook_step_register) },
        {
          text: localized(m.integrations_outlook_step_permissions),
          values: [
            "offline_access",
            "User.Read",
            "Mail.ReadWrite",
            "Mail.Send",
            "Calendars.ReadWrite",
          ],
        },
        { text: localized(m.integrations_outlook_step_secret) },
        { text: localized(m.integrations_outlook_step_paste) },
      ],
    },
  },
  apiKey: null,
  sharedCredential: null,
  toolSource: "static",
  tools: OUTLOOK_TOOLS,
  allowances: [
    {
      id: "send",
      label: localized(m.integrations_outlook_allowance_send),
      description: localized(m.integrations_outlook_allowance_send_description),
      tools: ["send_mail"],
      targets: "email",
      cap: 3,
    },
    {
      id: "invite",
      label: localized(m.integrations_outlook_allowance_invite),
      description: localized(m.integrations_outlook_allowance_invite_description),
      tools: ["create_event"],
      targets: "email",
      cap: 3,
    },
  ],
  scope: null,
  knowledgeSource: false,
} satisfies IntegrationManifest;
