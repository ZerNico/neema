import { Schema } from "effect";
import { defineIntegrationTool } from "../manifest.ts";

const optionalText = (description: string) =>
  Schema.optionalKey(Schema.String.annotate({ description }));

const optionalFlag = (description: string) =>
  Schema.optionalKey(Schema.Boolean.annotate({ description }));

/**
 * Offered as a list of addresses but decoding anything, so a model that sends
 * one string or a malformed list hears why from the handler instead of
 * failing the whole answer at decode.
 */
const addresses = (description: string) =>
  Schema.optionalKey(
    Schema.Any.check(
      Schema.makeFilter(() => true, {
        toJsonSchema: () => ({ type: "array", items: { type: "string" }, description }),
      }),
    ),
  );

const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const quoted = (value: string | undefined) => {
  const found = text(value);
  return found ? `“${found.length > 80 ? `${found.slice(0, 79)}…` : found}”` : null;
};
const names = (value: unknown) =>
  Array.isArray(value) && value.length
    ? value.filter((entry) => typeof entry === "string").join(", ")
    : null;

const searchMailTool = defineIntegrationTool({
  name: "search_mail",
  title: "Search mail",
  label: "Searched Outlook mail",
  description:
    "Search the user's mailbox. Returns sender, subject, date, a preview and an id per message, newest first; read a message for its full text. Without `query`, lists the newest messages in the inbox.",
  access: "read",
  parameters: Schema.Struct({
    query: optionalText(
      "Keywords, or Outlook search syntax such as from:ana@example.com or subject:invoice.",
    ),
  }),
  summarize: (args) => quoted(args.query),
});

const readMessageTool = defineIntegrationTool({
  name: "read_message",
  title: "Read messages",
  label: "Read an Outlook message",
  description:
    "Read one message as plain text by id, with its recipients. Long messages come back in parts; pass `offset` from the previous answer to continue. With `thread`, lists the other messages of its conversation too.",
  access: "read",
  parameters: Schema.Struct({
    id: optionalText("The message id from search_mail."),
    offset: Schema.optionalKey(
      Schema.Number.annotate({ description: "Character offset to continue from." }),
    ),
    thread: optionalFlag("Also list the conversation's other messages."),
  }),
  summarize: (args) => text(args.id),
});

const listEventsTool = defineIntegrationTool({
  name: "list_events",
  title: "List calendar events",
  label: "Checked the Outlook calendar",
  description:
    "List the user's calendar events between two times, expanded so recurring events appear once per occurrence.",
  access: "read",
  parameters: Schema.Struct({
    start: optionalText(
      "ISO 8601 date-time with offset, such as 2026-10-06T00:00:00+02:00; without one it is UTC.",
    ),
    end: optionalText("ISO 8601 date-time with offset; at most 62 days after start."),
    timeZone: optionalText("IANA time zone to return times in. Default UTC."),
  }),
  summarize: (args) =>
    text(args.start) && text(args.end) ? `${text(args.start)} to ${text(args.end)}` : null,
});

const checkAvailabilityTool = defineIntegrationTool({
  name: "check_availability",
  title: "Check availability",
  label: "Checked availability in Outlook",
  description:
    "Busy times of the user and of colleagues in the same organization between two times, to find a slot for a meeting. Returns busy blocks per person; free time is what lies between them.",
  access: "read",
  parameters: Schema.Struct({
    people: addresses("Colleagues' email addresses. The user is always included."),
    start: optionalText("ISO 8601 date-time with offset; without one it is UTC."),
    end: optionalText("ISO 8601 date-time with offset; at most 62 days after start."),
    timeZone: optionalText("IANA time zone to return times in. Default UTC."),
  }),
  summarize: (args) => names(args.people),
});

const createDraftTool = defineIntegrationTool({
  name: "create_draft",
  title: "Create drafts",
  label: "Drafted an Outlook message",
  description:
    "Save a message to the user's Drafts without sending it. A new message needs `to` and `subject`. Pass `replyTo` with a message id to draft a reply to its sender (`replyAll` for everyone on it); Outlook fills in recipients and subject. `body` is plain text.",
  access: "write",
  parameters: Schema.Struct({
    to: addresses("Recipients' email addresses, for a new message."),
    cc: addresses("Cc recipients' email addresses."),
    subject: optionalText("Subject, for a new message."),
    body: optionalText("The message text."),
    replyTo: optionalText("Id of the message to reply to."),
    replyAll: optionalFlag("With replyTo: reply to everyone on the message."),
  }),
  summarize: (args) => quoted(args.subject) ?? names(args.to),
});

const createEventTool = defineIntegrationTool({
  name: "create_event",
  title: "Create events",
  label: "Created an Outlook event",
  description:
    "Add an event to the user's calendar. With `attendees`, Outlook sends each of them an invitation as soon as it is created.",
  access: "write",
  parameters: Schema.Struct({
    subject: optionalText("Event title."),
    start: optionalText("ISO 8601 date-time, such as 2026-10-07T14:00:00."),
    end: optionalText("ISO 8601 date-time."),
    timeZone: optionalText("IANA time zone of start and end. Default UTC."),
    location: optionalText("Where it takes place."),
    body: optionalText("Description, plain text."),
    attendees: addresses("Email addresses to invite. Each gets an invitation."),
    online: optionalFlag("Add a Teams meeting link."),
  }),
  summarize: (args) => quoted(args.subject),
});

const sendMailTool = defineIntegrationTool({
  name: "send_mail",
  title: "Send mail",
  label: "Sent an Outlook message",
  description:
    "Send mail as the user. Pass `draftId` to send a saved draft exactly as its recipients stand, or `to`, `subject` and `body` to compose and send at once. Bcc is never sent. Only when the user asked for the message to go out.",
  access: "write",
  parameters: Schema.Struct({
    draftId: optionalText("Id of a draft to send."),
    to: addresses("Recipients' email addresses, when composing."),
    cc: addresses("Cc recipients' email addresses, when composing."),
    subject: optionalText("Subject, when composing."),
    body: optionalText("The message text, when composing."),
  }),
  summarize: (args) => quoted(args.subject) ?? names(args.to) ?? text(args.draftId),
});

export const OUTLOOK_TOOLS = [
  searchMailTool,
  readMessageTool,
  listEventsTool,
  checkAvailabilityTool,
  createDraftTool,
  createEventTool,
  sendMailTool,
] as const;
