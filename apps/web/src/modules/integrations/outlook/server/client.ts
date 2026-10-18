import { restCall } from "../../server/rest-call.ts";
import { Effect } from "effect";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../../errors.ts";
import type { IntegrationSession } from "../../server/adapter.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  webLink?: string;
  conversationId?: string;
  isDraft?: boolean;
  hasAttachments?: boolean;
}

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphEvent {
  id: string;
  subject?: string | null;
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  location?: { displayName?: string };
  organizer?: GraphRecipient;
  attendees?: Array<GraphRecipient & { type?: string; status?: { response?: string } }>;
  webLink?: string;
  onlineMeeting?: { joinUrl?: string } | null;
}

const graphError = (body: unknown) => {
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return null;
};

const reason = (status: number, body: unknown) => {
  const message = graphError(body);
  if (status === 404) return "Not found in Outlook.";
  if (status === 403)
    return `Outlook refused access${message ? `: ${message}` : ""}. The app registration may lack a permission (Mail.ReadWrite, Mail.Send, Calendars.ReadWrite), or the tenant has not consented to it.`;
  if (status === 429) return "Outlook is throttling requests; try again shortly.";
  return message ? `Outlook: ${message}` : `Outlook answered ${status}.`;
};

/**
 * One Graph request on a fixed origin. A throttled request is retried once:
 * 429 means it was not processed, so that holds for sending too; a 503 is
 * retried only for reads, since a send may have gone out before it.
 */
export const graphCall = <A>(
  session: IntegrationSession,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Effect.Effect<A, IntegrationAuthFailed | IntegrationRequestFailed> =>
  Effect.gen(function* () {
    const credential = yield* session.credential;
    // The manifest offers no API key; Graph only takes OAuth tokens.
    if (credential.kind !== "oauth")
      return yield* new IntegrationAuthFailed({
        integrationId: "outlook",
        ...(credential.identity ? { credential: credential.identity } : {}),
      });
    return yield* restCall<A>({
      service: "Outlook",
      integrationId: "outlook",
      credential,
      url: `${GRAPH}${path}`,
      method,
      authorization: `Bearer ${credential.accessToken}`,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      retry: (status) => status === 429 || (status === 503 && method === "GET"),
      reason,
    });
  });
