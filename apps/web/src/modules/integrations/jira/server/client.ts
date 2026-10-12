import { Duration, Effect } from "effect";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../../errors.ts";
import type { Credential, IntegrationSession } from "../../server/adapter.ts";

const GATEWAY = "https://api.atlassian.com";
const TIMEOUT_MS = 20_000;
/** The longest `Retry-After` honoured before giving up on a throttled call. */
const MAX_RETRY_WAIT_MS = 10_000;

export interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string | null;
  active?: boolean;
}

export interface JiraLinkedIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string } };
}

export interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { name?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    created?: string;
    updated?: string;
    duedate?: string | null;
    resolution?: { name?: string } | null;
    project?: { key?: string; name?: string };
    parent?: JiraLinkedIssue | null;
    subtasks?: JiraLinkedIssue[];
    issuelinks?: JiraIssueLink[];
  };
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  body?: unknown;
  created?: string;
}

/** The site's address, as `normalizeConfig` stored it: `https://<name>.atlassian.net`. */
export const siteOf = (config: Readonly<Record<string, string>>) => config.site ?? "";

export const issueUrl = (config: Readonly<Record<string, string>>, key: string) =>
  `${siteOf(config)}/browse/${encodeURIComponent(key)}`;

/**
 * A site's cloud id never changes, and OAuth calls need it in the path. Kept
 * per site for the process; the first lookup also proves the sign-in covers
 * that site rather than another the person can reach.
 */
const cloudIds = new Map<string, string>();

const fetchJson = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      }),
    catch: () =>
      new IntegrationRequestFailed({ status: null, message: "Jira could not be reached." }),
  });

const cloudIdFor = (site: string, credential: Extract<Credential, { kind: "oauth" }>) =>
  Effect.gen(function* () {
    const cached = cloudIds.get(site);
    if (cached) return cached;
    const response = yield* fetchJson(`${GATEWAY}/oauth/token/accessible-resources`, {
      headers: { accept: "application/json", authorization: `Bearer ${credential.accessToken}` },
    });
    if (response.status === 401)
      return yield* new IntegrationAuthFailed({
        integrationId: "jira",
        ...(credential.identity ? { credential: credential.identity } : {}),
      });
    const resources = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Array<{ id: string; url: string }>>,
      catch: () =>
        new IntegrationRequestFailed({
          status: response.status,
          message: `Atlassian answered ${response.status} without JSON.`,
        }),
    });
    const match = Array.isArray(resources)
      ? resources.find((resource) => resource.url.replace(/\/+$/, "") === site)
      : undefined;
    if (!match)
      return yield* new IntegrationRequestFailed({
        status: 403,
        message: `This Atlassian account has not granted access to ${site}. Reconnect and choose that site.`,
      });
    cloudIds.set(site, match.id);
    return match.id;
  });

/**
 * Where a request goes and how it is signed. OAuth tokens only work through
 * Atlassian's gateway; an API token signs in with its account's email,
 * directly at the site.
 */
const route = (site: string, credential: Credential) =>
  Effect.gen(function* () {
    if (credential.kind === "oauth") {
      const cloudId = yield* cloudIdFor(site, credential);
      return {
        base: `${GATEWAY}/ex/jira/${cloudId}/rest/api/3`,
        authorization: `Bearer ${credential.accessToken}`,
      };
    }
    const { email = "", token = "" } = credential.values;
    return {
      base: `${site}/rest/api/3`,
      authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    };
  });

/** Jira's own words: `errorMessages`, then each field's error by name. */
const jiraError = (body: unknown) => {
  if (!body || typeof body !== "object") return null;
  const messages =
    "errorMessages" in body && Array.isArray(body.errorMessages)
      ? body.errorMessages.filter((entry): entry is string => typeof entry === "string")
      : [];
  const fields =
    "errors" in body && body.errors && typeof body.errors === "object"
      ? Object.entries(body.errors).map(([field, message]) => `${field}: ${String(message)}`)
      : [];
  const all = [...messages, ...fields];
  return all.length ? all.join("; ") : null;
};

const reason = (status: number, body: unknown) => {
  const message = jiraError(body);
  if (status === 404)
    return message ? `Jira: ${message}` : "Not found in Jira, or this account cannot see it.";
  if (status === 403) return `Jira refused access${message ? `: ${message}` : "."}`;
  if (status === 429) return "Jira is rate limiting requests; try again shortly.";
  return message ? `Jira: ${message}` : `Jira answered ${status}.`;
};

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
};

/**
 * One Jira REST v3 request. Both origins are fixed (Atlassian's gateway, or
 * the admin's `*.atlassian.net` site), and a redirect is refused rather than
 * followed with credentials attached. A 429 was not processed, so it is
 * retried once whatever the method.
 */
export const jiraCall = <A>(
  session: IntegrationSession,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Effect.Effect<A, IntegrationAuthFailed | IntegrationRequestFailed> =>
  Effect.gen(function* () {
    const credential = yield* session.credential;
    const { base, authorization } = yield* route(siteOf(session.config), credential);
    const once = fetchJson(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let response = yield* once;
    const wait = retryAfter(response);
    if (response.status === 429 && wait <= MAX_RETRY_WAIT_MS) {
      yield* Effect.sleep(Duration.millis(wait));
      response = yield* once;
    }
    if (response.status === 401)
      return yield* new IntegrationAuthFailed({
        integrationId: "jira",
        ...(credential.identity ? { credential: credential.identity } : {}),
      });
    // Updates, assignments and transitions answer 204 with no body.
    const raw = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () =>
        new IntegrationRequestFailed({
          status: response.status,
          message: `Jira answered ${response.status} without a body.`,
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
            message: `Jira answered ${response.status} without JSON.`,
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
export const jiraPath = (path: string, query: Record<string, string | number | undefined>) => {
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return params.length ? `${path}?${params.join("&")}` : path;
};
