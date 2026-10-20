import { Effect } from "effect";
import { IntegrationRejected } from "../../errors.ts";
import { parseMailbox } from "../../mailbox.ts";
import { INTEGRATION_LIMITS } from "../../schema.ts";
import {
  integrationHandlers,
  ready,
  type AdapterToolResult,
  type IntegrationAdapter,
  type IntegrationSession,
} from "../../server/adapter.ts";
import { OUTLOOK_TOOLS } from "../tools.ts";
import {
  graphCall,
  type GraphDateTime,
  type GraphEvent,
  type GraphMessage,
  type GraphRecipient,
} from "./client.ts";
import { queryPath } from "../../server/rest-call.ts";

const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const reject = (reason: string) => Effect.fail(new IntegrationRejected({ reason }));

const MESSAGE_LIST_FIELDS = "id,subject,from,receivedDateTime,bodyPreview,webLink,isDraft";
const EVENT_FIELDS =
  "id,subject,start,end,isAllDay,location,organizer,attendees,webLink,onlineMeeting";
/** Graph's own ceiling for a calendar view or a free/busy query. */
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

const person = (recipient: GraphRecipient | null | undefined) => {
  const address = recipient?.emailAddress?.address ?? null;
  const name = recipient?.emailAddress?.name ?? null;
  return name && address && name !== address ? `${name} <${address}>` : (address ?? name);
};
const people = (recipients: ReadonlyArray<GraphRecipient> | undefined) =>
  (recipients ?? []).map(person).filter((entry): entry is string => entry !== null);
const toRecipients = (addresses: ReadonlyArray<string>) =>
  addresses.map((address) => ({ emailAddress: { address } }));

/**
 * Addresses the model passed, as the mailbox parser writes them. One string
 * with separators is accepted too; anything that is not a plain address is
 * refused by name rather than dropped.
 */
const addressList = (value: unknown, field: string) => {
  if (value === undefined || value === null) return Effect.succeed<string[]>([]);
  const raw =
    typeof value === "string"
      ? value.split(/[,;]/)
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : null;
  if (!raw) return reject(`\`${field}\` must be a list of email addresses.`);
  const parsed: string[] = [];
  for (const entry of raw.map((item) => item.trim()).filter(Boolean)) {
    const address = parseMailbox(entry);
    if (!address)
      return reject(
        `“${entry}” in \`${field}\` is not a plain email address like ana@example.com.`,
      );
    if (!parsed.includes(address)) parsed.push(address);
  }
  return Effect.succeed(parsed);
};

/** Recipients a stored message holds, refusing any the parser would not write the same way. */
const storedAddresses = (recipients: ReadonlyArray<GraphRecipient> | undefined) => {
  const parsed: string[] = [];
  for (const recipient of recipients ?? []) {
    const raw = recipient.emailAddress?.address ?? "";
    const address = parseMailbox(raw);
    if (!address)
      return reject(`The draft has a recipient that is not a plain email address (“${raw}”).`);
    if (!parsed.includes(address)) parsed.push(address);
  }
  return Effect.succeed(parsed);
};

/** An instant from ISO 8601; one without an offset is UTC, never the server's zone. */
const instant = (value: string | undefined) => {
  const found = text(value);
  if (!found) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(found) ? found : `${found}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
};

const range = (start: string | undefined, end: string | undefined) => {
  const from = instant(start);
  const to = instant(end);
  if (!from || !to) return reject("Pass `start` and `end` as ISO 8601 date-times.");
  if (to <= from) return reject("`end` must be after `start`.");
  if (to.getTime() - from.getTime() > MAX_RANGE_MS)
    return reject("Ask for at most 62 days at a time.");
  return Effect.succeed({ from, to });
};

const zone = (value: string | undefined) => {
  const found = text(value) ?? "UTC";
  try {
    return Effect.succeed(
      new Intl.DateTimeFormat("en", { timeZone: found }).resolvedOptions().timeZone,
    );
  } catch {
    return reject(`“${found}” is not an IANA time zone such as Europe/Berlin.`);
  }
};

/** Graph wants a wall-clock time plus a zone; an offset given instead is turned into UTC. */
const wallClock = (value: string, timeZone: string) => {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return { dateTime: value, timeZone };
  return { dateTime: new Date(value).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
};

const timesIn = (timeZone: string) => ({ Prefer: `outlook.timezone="${timeZone}"` });

const messageSummary = (message: GraphMessage) => ({
  id: message.id,
  subject: message.subject ?? "",
  from: person(message.from),
  receivedAt: message.receivedDateTime ?? null,
  preview: (message.bodyPreview ?? "").slice(0, 300),
  ...(message.isDraft ? { draft: true } : {}),
  url: message.webLink ?? null,
});

const messageSources = (messages: ReadonlyArray<GraphMessage>, read: boolean) =>
  messages
    .filter((message) => message.webLink)
    .map((message) => ({
      externalId: message.id,
      title: message.subject || "(no subject)",
      url: message.webLink!,
      snippet: (message.bodyPreview ?? "").slice(0, 300),
      read,
    }));

const eventSummary = (event: GraphEvent) => ({
  id: event.id,
  subject: event.subject ?? "",
  start: event.start ?? null,
  end: event.end ?? null,
  ...(event.isAllDay ? { allDay: true } : {}),
  location: event.location?.displayName || null,
  organizer: person(event.organizer),
  attendees: (event.attendees ?? []).map((attendee) => ({
    who: person(attendee),
    response: attendee.status?.response ?? null,
  })),
  joinUrl: event.onlineMeeting?.joinUrl ?? null,
  url: event.webLink ?? null,
});

const draftResult = (draft: GraphMessage): AdapterToolResult => ({
  output: {
    draftId: draft.id,
    subject: draft.subject ?? "",
    to: people(draft.toRecipients),
    cc: people(draft.ccRecipients),
    url: draft.webLink ?? null,
    note: "Saved to Drafts. Nothing was sent.",
  },
  ...(draft.webLink ? { link: { title: draft.subject || "Draft", url: draft.webLink } } : {}),
});

const recipientLine = (targets: ReadonlyArray<string>) =>
  targets.length > 3
    ? `${targets.slice(0, 3).join(", ")} and ${targets.length - 3} more`
    : targets.join(", ");

const handlers = integrationHandlers(OUTLOOK_TOOLS)({
  search_mail: (session, args) =>
    Effect.succeed(
      ready(
        Effect.gen(function* () {
          const query = text(args.query);
          const path = query
            ? queryPath("/me/messages", {
                $search: `"${query.replace(/"/g, '\\"')}"`,
                $top: INTEGRATION_LIMITS.searchResults,
                $select: MESSAGE_LIST_FIELDS,
              })
            : queryPath("/me/mailFolders/inbox/messages", {
                $top: INTEGRATION_LIMITS.searchResults,
                $orderby: "receivedDateTime desc",
                $select: MESSAGE_LIST_FIELDS,
              });
          const { value } = yield* graphCall<{ value: GraphMessage[] }>(session, "GET", path);
          return {
            output: value.length
              ? { messages: value.map(messageSummary) }
              : { messages: [], note: "No messages matched." },
            sources: messageSources(value, false),
          };
        }),
      ),
    ),

  read_message: (session, args) =>
    Effect.gen(function* () {
      const id = text(args.id);
      if (!id) return yield* reject("Pass `id` of the message to read.");
      const offset = args.offset !== undefined && args.offset > 0 ? Math.floor(args.offset) : 0;
      return ready(
        Effect.gen(function* () {
          const message = yield* graphCall<GraphMessage>(
            session,
            "GET",
            queryPath(`/me/messages/${encodeURIComponent(id)}`, {
              $select:
                "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,webLink,conversationId,isDraft,hasAttachments",
            }),
            { headers: { Prefer: 'outlook.body-content-type="text"' } },
          );
          const body = message.body?.content ?? "";
          const end = Math.min(body.length, offset + INTEGRATION_LIMITS.readChars);
          const thread =
            args.thread && message.conversationId
              ? (yield* graphCall<{ value: GraphMessage[] }>(
                  session,
                  "GET",
                  queryPath("/me/messages", {
                    $filter: `conversationId eq '${message.conversationId.replace(/'/g, "''")}'`,
                    $top: 25,
                    $select: MESSAGE_LIST_FIELDS,
                  }),
                )).value
                  .filter((entry) => entry.id !== message.id)
                  .toSorted((a, b) =>
                    (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""),
                  )
                  .map(messageSummary)
              : undefined;
          return {
            output: {
              id: message.id,
              subject: message.subject ?? "",
              from: person(message.from),
              to: people(message.toRecipients),
              cc: people(message.ccRecipients),
              receivedAt: message.receivedDateTime ?? null,
              ...(message.isDraft ? { draft: true } : {}),
              hasAttachments: message.hasAttachments ?? false,
              url: message.webLink ?? null,
              totalChars: body.length,
              offset,
              nextOffset: end < body.length ? end : null,
              text: body.slice(offset, end),
              ...(thread ? { thread } : {}),
            },
            sources: messageSources([message], true),
          };
        }),
      );
    }),

  list_events: (session, args) =>
    Effect.gen(function* () {
      const { from, to } = yield* range(args.start, args.end);
      const timeZone = yield* zone(args.timeZone);
      return ready(
        Effect.gen(function* () {
          const { value } = yield* graphCall<{ value: GraphEvent[] }>(
            session,
            "GET",
            queryPath("/me/calendarView", {
              startDateTime: from.toISOString(),
              endDateTime: to.toISOString(),
              $top: INTEGRATION_LIMITS.listResults,
              $orderby: "start/dateTime",
              $select: EVENT_FIELDS,
            }),
            { headers: timesIn(timeZone) },
          );
          return {
            output: value.length
              ? { timeZone, events: value.map(eventSummary) }
              : { timeZone, events: [], note: "No events in that range." },
          };
        }),
      );
    }),

  check_availability: (session, args) =>
    Effect.gen(function* () {
      const { from, to } = yield* range(args.start, args.end);
      const timeZone = yield* zone(args.timeZone);
      const colleagues = yield* addressList(args.people, "people");
      if (colleagues.length > 20) return yield* reject("Check at most 20 people at once.");
      return ready(
        Effect.gen(function* () {
          const me = yield* graphCall<{ mail?: string | null; userPrincipalName?: string }>(
            session,
            "GET",
            "/me?$select=mail,userPrincipalName",
          );
          const self = (me.mail || me.userPrincipalName || "").toLowerCase();
          const schedules = [...new Set([self, ...colleagues].filter(Boolean))];
          const { value } = yield* graphCall<{
            value: Array<{
              scheduleId: string;
              error?: { message?: string };
              scheduleItems?: Array<{
                status?: string;
                start?: GraphDateTime;
                end?: GraphDateTime;
              }>;
            }>;
          }>(session, "POST", "/me/calendar/getSchedule", {
            body: {
              schedules,
              startTime: { dateTime: from.toISOString().replace(/Z$/, ""), timeZone: "UTC" },
              endTime: { dateTime: to.toISOString().replace(/Z$/, ""), timeZone: "UTC" },
              availabilityViewInterval: 30,
            },
            headers: timesIn(timeZone),
          });
          return {
            output: {
              timeZone,
              people: value.map((entry) => ({
                who: entry.scheduleId,
                ...(entry.scheduleId.toLowerCase() === self ? { isUser: true } : {}),
                ...(entry.error
                  ? { unavailable: entry.error.message ?? "No free/busy information." }
                  : {
                      busy: (entry.scheduleItems ?? [])
                        .filter((item) => item.status !== "free")
                        .map((item) => ({
                          start: item.start?.dateTime ?? null,
                          end: item.end?.dateTime ?? null,
                          status: item.status ?? "busy",
                        })),
                    }),
              })),
            },
          };
        }),
      );
    }),

  create_draft: (session, args) =>
    Effect.gen(function* () {
      const replyTo = text(args.replyTo);
      const to = yield* addressList(args.to, "to");
      const cc = yield* addressList(args.cc, "cc");
      const body = args.body ?? "";
      if (replyTo) {
        if (to.length || cc.length || text(args.subject))
          return yield* reject(
            "A reply takes its recipients and subject from the message; pass only `replyTo`, `replyAll` and `body`.",
          );
        const action = args.replyAll ? "createReplyAll" : "createReply";
        return ready(
          graphCall<GraphMessage>(
            session,
            "POST",
            `/me/messages/${encodeURIComponent(replyTo)}/${action}`,
            { body: { comment: body } },
          ).pipe(Effect.map(draftResult)),
        );
      }
      const subject = text(args.subject);
      if (to.length === 0) return yield* reject("Pass `to` with at least one address.");
      if (!subject) return yield* reject("Pass `subject`.");
      return ready(
        graphCall<GraphMessage>(session, "POST", "/me/messages", {
          body: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: toRecipients(to),
            ccRecipients: toRecipients(cc),
          },
        }).pipe(Effect.map(draftResult)),
      );
    }),

  create_event: (session, args) =>
    Effect.gen(function* () {
      const subject = text(args.subject);
      const start = text(args.start);
      const end = text(args.end);
      if (!subject) return yield* reject("Pass `subject`.");
      if (!start || !end) return yield* reject("Pass `start` and `end` as ISO 8601 date-times.");
      yield* range(start, end);
      const timeZone = yield* zone(args.timeZone);
      const attendees = yield* addressList(args.attendees, "attendees");
      const location = text(args.location);
      return {
        summary: `“${subject}” · ${start}`,
        // Graph invites every attendee the moment the event exists.
        reach: { allowance: "invite", targets: attendees },
        scope: null,
        execute: graphCall<GraphEvent>(session, "POST", "/me/events", {
          body: {
            subject,
            start: wallClock(start, timeZone),
            end: wallClock(end, timeZone),
            ...(args.body ? { body: { contentType: "Text", content: args.body } } : {}),
            ...(location ? { location: { displayName: location } } : {}),
            attendees: attendees.map((address) => ({
              emailAddress: { address },
              type: "required",
            })),
            ...(args.online
              ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }
              : {}),
          },
        }).pipe(
          Effect.map((event) => ({
            output: { ...eventSummary(event), invited: attendees },
            ...(event.webLink ? { link: { title: subject, url: event.webLink } } : {}),
          })),
        ),
      };
    }),

  send_mail: (session, args) =>
    Effect.gen(function* () {
      const draftId = text(args.draftId);
      const to = yield* addressList(args.to, "to");
      const cc = yield* addressList(args.cc, "cc");
      if (draftId) {
        if (to.length || cc.length || text(args.subject) || args.body !== undefined)
          return yield* reject(
            "Sending a draft sends it as saved; pass only `draftId`, or change the draft first.",
          );
        // Read the draft now: what is checked and approved is what it holds.
        const draft = yield* graphCall<GraphMessage>(
          session,
          "GET",
          queryPath(`/me/messages/${encodeURIComponent(draftId)}`, {
            $select: "id,subject,isDraft,toRecipients,ccRecipients,bccRecipients,webLink",
          }),
        );
        if (!draft.isDraft) return yield* reject("That message is not a draft.");
        if (draft.bccRecipients?.length)
          return yield* reject(
            "The draft has Bcc recipients, and Bcc is never sent from here. Remove them in Outlook, or let the user send it.",
          );
        const draftTo = yield* storedAddresses(draft.toRecipients);
        const draftCc = (yield* storedAddresses(draft.ccRecipients)).filter(
          (address) => !draftTo.includes(address),
        );
        const targets = [...draftTo, ...draftCc];
        if (targets.length === 0) return yield* reject("The draft has no recipients yet.");
        const subject = draft.subject ?? "";
        return {
          summary: `“${subject || "(no subject)"}” to ${recipientLine(targets)}`,
          reach: { allowance: "send", targets },
          scope: null,
          // Pin the recipients to the ones checked, so an edit made in the
          // meantime cannot add someone, then send that same draft.
          execute: graphCall<unknown>(
            session,
            "PATCH",
            `/me/messages/${encodeURIComponent(draftId)}`,
            {
              body: {
                toRecipients: toRecipients(draftTo),
                ccRecipients: toRecipients(draftCc),
                bccRecipients: [],
              },
            },
          ).pipe(
            Effect.andThen(
              graphCall<unknown>(
                session,
                "POST",
                `/me/messages/${encodeURIComponent(draftId)}/send`,
              ),
            ),
            Effect.as({ output: { sent: true, subject, to: draftTo, cc: draftCc } }),
          ),
        };
      }
      const subject = text(args.subject);
      if (to.length === 0)
        return yield* reject("Pass `to` with at least one address, or `draftId`.");
      if (!subject) return yield* reject("Pass `subject`.");
      if (!text(args.body)) return yield* reject("Pass `body` with the message text.");
      const copied = cc.filter((address) => !to.includes(address));
      const targets = [...to, ...copied];
      return {
        summary: `“${subject}” to ${recipientLine(targets)}`,
        reach: { allowance: "send", targets },
        scope: null,
        execute: graphCall<unknown>(session, "POST", "/me/sendMail", {
          body: {
            message: {
              subject,
              body: { contentType: "Text", content: args.body },
              toRecipients: toRecipients(to),
              ccRecipients: toRecipients(copied),
            },
            saveToSentItems: true,
          },
        }).pipe(Effect.as({ output: { sent: true, subject, to, cc: copied } })),
      };
    }),
});

const TENANT = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const loginBase = (config: Readonly<Record<string, string>>) =>
  `https://login.microsoftonline.com/${encodeURIComponent(config.tenant || "organizations")}/oauth2/v2.0`;

export const outlookAdapter: IntegrationAdapter = {
  kind: "outlook",
  normalizeConfig: (config) => {
    const tenant = (config.tenant ?? "").trim().toLowerCase() || "organizations";
    if (!TENANT.test(tenant))
      return { error: "Enter a directory (tenant) ID or domain, or leave it empty." };
    return { config: { tenant }, fingerprint: tenant };
  },
  oauth: {
    // The picker every time, so adding a second account does not quietly sign
    // in the one the browser already has.
    authorizeUrl: (config) => `${loginBase(config)}/authorize?prompt=select_account`,
    tokenUrl: (config) => `${loginBase(config)}/token`,
    scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
  },
  verify: (session: IntegrationSession) =>
    graphCall<{
      id?: string;
      displayName?: string;
      mail?: string | null;
      userPrincipalName?: string;
    }>(session, "GET", "/me?$select=id,displayName,mail,userPrincipalName").pipe(
      Effect.map((me) => ({
        accountLabel: me.mail || me.userPrincipalName || me.displayName || "Outlook account",
        accountKey: me.id ?? null,
      })),
    ),
  handlers,
  scopeOptions: null,
  knowledge: null,
};
