import { Duration, Effect } from "effect";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../../errors.ts";
import type { IntegrationSession } from "../../server/adapter.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 20_000;
/** The longest `Retry-After` honoured before giving up on a throttled call. */
const MAX_RETRY_WAIT_MS = 10_000;

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

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
};

/**
 * One Graph request on a fixed origin. A redirect is refused rather than
 * followed with the bearer attached. A throttled request is retried once:
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
    const token = yield* session.bearer;
    const once = Effect.tryPromise({
      try: (signal) =>
        fetch(`${GRAPH}${path}`, {
          method,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        }),
      catch: () =>
        new IntegrationRequestFailed({
          status: null,
          message: "Outlook could not be reached.",
        }),
    });
    let response = yield* once;
    const wait = retryAfter(response);
    if (
      (response.status === 429 || (response.status === 503 && method === "GET")) &&
      wait <= MAX_RETRY_WAIT_MS
    ) {
      yield* Effect.sleep(Duration.millis(wait));
      response = yield* once;
    }
    if (response.status === 401)
      return yield* new IntegrationAuthFailed({ integrationId: "outlook" });
    // Sending and other actions answer 202 or 204 with no body.
    const raw = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new IntegrationRequestFailed({
          status: response.status,
          message: `Outlook answered ${response.status} without a body.`,
        }),
    });
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        if (response.ok)
          return yield* new IntegrationRequestFailed({
            status: response.status,
            message: `Outlook answered ${response.status} without JSON.`,
          });
      }
    }
    if (!response.ok)
      return yield* new IntegrationRequestFailed({
        status: response.status,
        message: reason(response.status, json),
      });
    return json as A;
  });

/** A path with its query string, each value encoded once. */
export const graphPath = (path: string, query: Record<string, string | number | undefined>) => {
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return params.length ? `${path}?${params.join("&")}` : path;
};
