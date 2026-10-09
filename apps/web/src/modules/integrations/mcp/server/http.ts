import { Effect } from "effect";
import { fetchPinned, resolvePublicHttpUrl } from "~/modules/tools/server/url-safety.ts";

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** A response body past this many bytes fails the request rather than filling memory. */
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * What a server last said about authorization, read from `WWW-Authenticate`
 * as the response arrives, so a 401 or a 403 `insufficient_scope` is known
 * however the SDK words the error it throws.
 */
export interface AuthChallenge {
  status: 401 | 403;
  error: string | null;
  scopes: string[];
}

const challengeParam = (header: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`, "i").exec(header)?.[1] ??
  new RegExp(`${name}=([^\\s,]+)`, "i").exec(header)?.[1] ??
  null;

export const readChallenge = (response: Response): AuthChallenge | null => {
  if (response.status !== 401 && response.status !== 403) return null;
  const header = response.headers.get("www-authenticate") ?? "";
  const scope = challengeParam(header, "scope");
  return {
    status: response.status,
    error: challengeParam(header, "error"),
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
  };
};

const capped = (response: Response) => {
  if (!response.body) return response;
  let seen = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > MAX_RESPONSE_BYTES) controller.error(new Error("The response was too large."));
      else controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limit), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** `fetchPinned` takes text or bytes; the SDK also sends forms. */
const plainBody = (init: RequestInit | undefined): RequestInit => {
  const body = init?.body;
  if (body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array)
    return init ?? {};
  if (body instanceof URLSearchParams) {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");
    return { ...init, headers, body: body.toString() };
  }
  throw new Error("Unsupported request body.");
};

/**
 * Requests for one MCP integration. Its own origin is the admin's choice and
 * may be private, like a self-hosted Outline: it is reached directly, never
 * following a redirect, so a bearer token cannot be carried elsewhere. Any
 * other origin (the sign-in server, a registration endpoint) is named by the
 * server itself, so it must be public and is connected to at the addresses
 * that were checked.
 */
export const scopedFetch = (
  serverUrl: URL,
  options: {
    onChallenge?: (challenge: AuthChallenge) => void;
    sameOriginOnly?: boolean;
    /** Ends every request made through this fetch, whatever the caller passes. */
    signal?: AbortSignal;
  } = {},
): Fetch => {
  return async (input, init) => {
    const url = new URL(input);
    const own = options.signal;
    const given = init?.signal ?? undefined;
    const signal = own && given ? AbortSignal.any([own, given]) : (own ?? given);
    const request = { ...plainBody(init), ...(signal ? { signal } : {}) };
    let response: Response;
    if (url.origin === serverUrl.origin) {
      response = await fetch(url, { ...request, redirect: "manual" });
    } else {
      if (options.sameOriginOnly) throw new Error(`Refused a request to ${url.origin}.`);
      const target = await Effect.runPromise(resolvePublicHttpUrl(url.toString())).catch(() => {
        throw new Error(`Refused a request to ${url.origin}: it is not a public address.`);
      });
      response = await fetchPinned(target, request);
    }
    const challenge = readChallenge(response);
    if (challenge) options.onChallenge?.(challenge);
    return capped(response);
  };
};
