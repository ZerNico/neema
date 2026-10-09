import {
  Client,
  ProtocolError,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type DiscoverResult,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../../errors.ts";
import type { AdapterFailure, Credential } from "../../server/adapter.ts";
import { scopedFetch, type AuthChallenge } from "./http.ts";

const CLIENT_INFO = { name: "neema", version: "1.0.0" };
/** One request, a person's answer to an elicitation included. Stop ends it sooner. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
/** How long a server's protocol era is trusted before it is probed again. */
const ERA_TTL_MS = 10 * 60_000;

/**
 * What a call asks the person when the server needs input mid-call. Absent
 * (a catalog check, a scheduled run), every request is declined.
 */
export type Elicit = (request: ElicitRequest["params"]) => Promise<ElicitResult>;

type Era =
  | {
      transport: "streamable";
      prior: { kind: "modern"; discover: DiscoverResult } | { kind: "legacy" };
    }
  | { transport: "sse" };

/**
 * Each server's era, by address and credential holder, so a stateless
 * (2026-07-28) server costs no extra round trip per call, and an old SSE
 * server is not probed with Streamable HTTP every time.
 */
const eras = new Map<string, { era: Era; until: number }>();

const eraKey = (url: URL, holder: string) => `${url.href}\u0000${holder}`;

export const authHeaders = (
  credential: Credential,
  header: string | undefined,
): Record<string, string> => {
  if (credential.kind === "none") return {};
  const token = credential.kind === "oauth" ? credential.accessToken : credential.values.token;
  if (!token) return {};
  const name = header?.trim() || "Authorization";
  return { [name]: name.toLowerCase() === "authorization" ? `Bearer ${token}` : token };
};

export interface Connection {
  readonly client: Client;
  /** The server's last `WWW-Authenticate` challenge, for a refusal the SDK words vaguely. */
  readonly challenge: () => AuthChallenge | null;
}

const httpStatus = (error: unknown) => (error instanceof SdkHttpError ? error.status : null);

/** A failure in a sentence the person can act on; auth failures become their own kind. */
export const toFailure = (
  integrationId: string,
  error: unknown,
  challenge: AuthChallenge | null,
): AdapterFailure => {
  const status = challenge?.status ?? httpStatus(error);
  if (status === 401) return new IntegrationAuthFailed({ integrationId });
  if (status === 403 && challenge?.error === "insufficient_scope")
    return new IntegrationRequestFailed({
      status: 403,
      message: "The server needs more access than this sign-in granted.",
      ...(challenge.scopes.length ? { missingScopes: challenge.scopes } : {}),
    });
  if (error instanceof ProtocolError)
    return new IntegrationRequestFailed({
      status: null,
      message: `The server refused the request: ${error.message}`.slice(0, 280),
    });
  if (error instanceof Error && error.name === "AbortError")
    return new IntegrationRequestFailed({ status: null, message: "The request was stopped." });
  const message = error instanceof Error ? error.message : String(error);
  return new IntegrationRequestFailed({
    status,
    message: status
      ? `The server answered ${status}.`
      : /timed? ?out/i.test(message)
        ? "The server did not answer in time."
        : "The server could not be reached.",
  });
};

/**
 * One client for one piece of work, closed when the scope ends. Each call
 * gets its own: a modern server is stateless anyway, and a legacy session
 * then never outlives the answer that opened it.
 */
export const connect = (input: {
  integrationId: string;
  url: URL;
  credential: Credential;
  header: string | undefined;
  /** Who the credential belongs to, so eras are not shared across accounts. */
  holder: string;
  elicit?: Elicit;
}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let challenge: AuthChallenge | null = null;
      const fetch = scopedFetch(input.url, {
        sameOriginOnly: true,
        onChallenge: (next) => {
          challenge = next;
        },
      });
      const headers = authHeaders(input.credential, input.header);
      const client = new Client(CLIENT_INFO, {
        capabilities: input.elicit ? { elicitation: { form: {}, url: {} } } : {},
        versionNegotiation: { mode: "auto" },
      });
      // A legacy server asks mid-call; a modern one answers `input_required`,
      // which the SDK turns into this same request and retries with the answer.
      // Without anyone to ask, the capability is not declared and nobody asks.
      const elicit = input.elicit;
      if (elicit)
        client.setRequestHandler("elicitation/create", (request) => elicit(request.params));
      const key = eraKey(input.url, input.holder);
      const cached = eras.get(key);
      const known = cached && cached.until > Date.now() ? cached.era : null;

      const streamable = () =>
        new StreamableHTTPClientTransport(input.url, {
          fetch,
          requestInit: { headers },
          redirectPolicy: "same-origin",
        });
      const sse = () => new SSEClientTransport(input.url, { fetch, requestInit: { headers } });

      const attempt = (era: "streamable" | "sse", prior?: Era) =>
        Effect.tryPromise({
          try: (signal) =>
            client.connect(era === "sse" ? sse() : streamable(), {
              signal,
              timeout: CONNECT_TIMEOUT_MS,
              ...(prior?.transport === "streamable" ? { prior: prior.prior } : {}),
            }),
          catch: (error) => error,
        });

      const remember = (transport: "streamable" | "sse") => {
        const discover = client.getDiscoverResult();
        const era: Era =
          transport === "sse"
            ? { transport }
            : {
                transport,
                prior: discover ? { kind: "modern", discover } : { kind: "legacy" },
              };
        eras.set(key, { era, until: Date.now() + ERA_TTL_MS });
      };

      const connected = yield* (
        known?.transport === "sse" ? attempt("sse") : attempt("streamable", known ?? undefined)
      ).pipe(
        Effect.as(known?.transport ?? "streamable"),
        Effect.catch((error) => {
          const status = httpStatus(error);
          // The 2024 HTTP+SSE transport answers a Streamable HTTP POST with
          // 404 or 405; the spec's compatibility path is to try it next.
          if (known === null && (status === 404 || status === 405 || status === 400))
            return attempt("sse").pipe(Effect.as("sse" as const));
          return Effect.fail(error);
        }),
        Effect.mapError((error) => toFailure(input.integrationId, error, challenge)),
      );
      remember(connected);
      return { client, challenge: () => challenge } satisfies Connection;
    }),
    ({ client }) => Effect.promise(() => client.close().catch(() => undefined)),
  );

/** Forgets what was learned about a server, after it changed address or failed oddly. */
export const forgetEra = (url: URL, holder: string) => eras.delete(eraKey(url, holder));

export const REQUEST_OPTIONS = { timeout: REQUEST_TIMEOUT_MS } as const;
