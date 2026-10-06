import { Effect } from "effect";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../../errors.ts";
import type { IntegrationSession } from "../../server/adapter.ts";

const TIMEOUT_MS = 20_000;

export interface OutlineDocument {
  id: string;
  title: string;
  text?: string;
  url: string;
  collectionId?: string | null;
  parentDocumentId?: string | null;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface OutlineNavigationNode {
  id: string;
  title: string;
  url: string;
  children?: OutlineNavigationNode[];
}

export interface OutlineCollection {
  id: string;
  name: string;
  url: string;
}

export const outlineBase = (config: Readonly<Record<string, string>>) =>
  (config.baseUrl ?? "").replace(/\/+$/, "");

/** Outline answers relative paths; the model and citations need absolute links. */
export const absoluteUrl = (config: Readonly<Record<string, string>>, path: string) =>
  /^https?:\/\//.test(path)
    ? path
    : `${outlineBase(config)}${path.startsWith("/") ? "" : "/"}${path}`;

const reason = (status: number, body: unknown) => {
  const message =
    body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : null;
  if (status === 404) return "Not found in Outline.";
  if (status === 403) return "Outline refused access to that.";
  if (status === 429) return "Outline is rate limiting requests; try again shortly.";
  return message ? `Outline: ${message}` : `Outline answered ${status}.`;
};

/**
 * One RPC-style call (`POST /api/<method>`). The base URL is the admin's, so it
 * is exempt from the public-address check like SearXNG, but a redirect off
 * that origin is refused rather than followed with the bearer attached.
 */
export const outlineCall = <A>(
  session: IntegrationSession,
  method: string,
  body: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const credential = yield* session.credential;
    // Outline takes its own OAuth tokens and API keys alike as a bearer.
    const token = credential.kind === "oauth" ? credential.accessToken : credential.values.key;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${outlineBase(session.config)}/api/${method}`, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }),
      catch: () =>
        new IntegrationRequestFailed({ status: null, message: "Outline could not be reached." }),
    });
    if (response.status === 401)
      return yield* new IntegrationAuthFailed({ integrationId: "outline" });
    const json: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new IntegrationRequestFailed({
          status: response.status,
          message: `Outline answered ${response.status} without JSON.`,
        }),
    });
    if (!response.ok)
      return yield* new IntegrationRequestFailed({
        status: response.status,
        message: reason(response.status, json),
      });
    return json as { data: A; pagination?: { offset: number; limit: number } };
  });

/**
 * Pages through a list method until it runs dry, reaches `max` items, or
 * meets an item `stop` accepts (that item and everything after it are left
 * out, so a newest-first listing can end where the last sync left off).
 */
export const outlineList = <A>(
  session: IntegrationSession,
  method: string,
  body: Record<string, unknown>,
  max: number,
  stop?: (item: A) => boolean,
) =>
  Effect.gen(function* () {
    const items: A[] = [];
    const limit = 100;
    for (let offset = 0; items.length < max; offset += limit) {
      const page = yield* outlineCall<A[]>(session, method, { ...body, offset, limit });
      const end = stop ? page.data.findIndex(stop) : -1;
      items.push(...(end === -1 ? page.data : page.data.slice(0, end)));
      if (end !== -1 || page.data.length < limit) break;
    }
    return items.slice(0, max);
  });
