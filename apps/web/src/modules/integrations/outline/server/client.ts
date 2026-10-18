import { restCall } from "../../server/rest-call.ts";
import { Effect } from "effect";
import type { IntegrationSession } from "../../server/adapter.ts";

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
 * is exempt from the public-address check like SearXNG. A throttled call was
 * not processed, so it is retried once.
 */
export const outlineCall = <A>(
  session: IntegrationSession,
  method: string,
  body: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const credential = yield* session.credential;
    // Outline takes its own OAuth tokens and API keys alike as a bearer.
    const token =
      credential.kind === "oauth"
        ? credential.accessToken
        : credential.kind === "api_key"
          ? credential.values.key
          : "";
    return yield* restCall<{ data: A; pagination?: { offset: number; limit: number } }>({
      service: "Outline",
      integrationId: "outline",
      credential,
      url: `${outlineBase(session.config)}/api/${method}`,
      method: "POST",
      authorization: `Bearer ${token}`,
      body,
      retry: (status) => status === 429,
      reason,
    });
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
