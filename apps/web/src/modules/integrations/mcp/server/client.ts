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
import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  IntegrationAuthFailed,
  IntegrationRequestFailed,
  type CredentialIdentity,
} from "../../errors.ts";
import type { AdapterFailure, Credential } from "../../server/adapter.ts";
import { scopedFetch, type AuthChallenge } from "./http.ts";

const CLIENT_INFO = { name: "neema", version: "1.0.0" };
/** One request, a person's answer to an elicitation included. Stop ends it sooner. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
/** How long a legacy session's closing request may take before it is left to expire. */
const TERMINATE_TIMEOUT_MS = 5_000;
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
 * Each server's era, by address and credential, so a stateless (2026-07-28)
 * server costs no extra round trip per call, and an old SSE server is not
 * probed with Streamable HTTP every time. Per credential, since what a
 * server says about itself may depend on who asks.
 */
const eras = new Map<string, { era: Era; until: number }>();
/** Servers times accounts; past this the oldest are probed again, which only costs a round trip. */
const MAX_ERAS = 2_000;

const eraKey = (url: URL, headers: Record<string, string>) =>
  `${url.href}\u0000${createHash("sha256").update(JSON.stringify(headers)).digest("base64url")}`;

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
  /** Forgets what was learned about the server: a request on it failed, so ask again next time. */
  readonly forget: () => void;
  /** The Streamable HTTP transport in use, if any, to end a legacy session with. */
  readonly transport: () => StreamableHTTPClientTransport | null;
  /** The server's last `WWW-Authenticate` challenge, for a refusal the SDK words vaguely. */
  readonly challenge: () => AuthChallenge | null;
  /** The credential this connection sends, so a refusal names it and no later one. */
  readonly identity: CredentialIdentity | undefined;
}

const httpStatus = (error: unknown) => (error instanceof SdkHttpError ? error.status : null);

/** A failure in a sentence the person can act on; auth failures become their own kind. */
export const toFailure = (
  integrationId: string,
  error: unknown,
  challenge: AuthChallenge | null,
  credential: CredentialIdentity | undefined,
): AdapterFailure => {
  const status = challenge?.status ?? httpStatus(error);
  if (status === 401)
    return new IntegrationAuthFailed({ integrationId, ...(credential ? { credential } : {}) });
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
  publicOnly: boolean;
  elicit?: Elicit;
}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let challenge: AuthChallenge | null = null;
      const fetch = scopedFetch(input.url, {
        sameOriginOnly: true,
        publicOnly: input.publicOnly,
        onChallenge: (next) => {
          challenge = next;
        },
      });
      const headers = authHeaders(input.credential, input.header);
      const client = new Client(CLIENT_INFO, {
        capabilities: input.elicit ? { elicitation: { form: {}, url: {} } } : {},
        versionNegotiation: { mode: "auto" },
        // Pages a listing may follow; the byte limit on the fetch bounds them too.
        listMaxPages: 10,
      });
      // A legacy server asks mid-call; a modern one answers `input_required`,
      // which the SDK turns into this same request and retries with the answer.
      // Without anyone to ask, the capability is not declared and nobody asks.
      const elicit = input.elicit;
      if (elicit)
        client.setRequestHandler("elicitation/create", (request) => elicit(request.params));
      const key = eraKey(input.url, headers);
      const cached = eras.get(key);
      const known = cached && cached.until > Date.now() ? cached.era : null;

      let current: StreamableHTTPClientTransport | null = null;
      const streamable = () =>
        (current = new StreamableHTTPClientTransport(input.url, {
          fetch,
          requestInit: { headers },
          redirectPolicy: "same-origin",
        }));
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
        if (eras.size > MAX_ERAS) eras.delete(eras.keys().next().value!);
      };

      // Learned once and trusted until it lapses, counted from when it was
      // learned: steady traffic must not keep a server from being asked again.
      // An attempt on what was learned that fails forgets it.
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
          if (known) eras.delete(key);
          return Effect.fail(error);
        }),
        Effect.mapError((error) =>
          toFailure(input.integrationId, error, challenge, input.credential.identity),
        ),
        // A handshake that opened a session and then failed still ends it.
        Effect.onError(() => Effect.promise(() => release(client, current))),
      );
      if (!known) remember(connected);
      return {
        client,
        challenge: () => challenge,
        identity: input.credential.identity,
        forget: () => void eras.delete(key),
        transport: () => current,
      } satisfies Connection;
    }),
    ({ client, transport }) => Effect.promise(() => release(client, transport())),
  );

/**
 * A legacy server keeps a session until told it is over; closing the
 * client only drops our side, so the session is ended first, briefly.
 */
const release = async (client: Client, session: StreamableHTTPClientTransport | null) => {
  if (session?.sessionId)
    await Promise.race([
      session.terminateSession().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS)),
    ]);
  await client.close().catch(() => undefined);
};

export const REQUEST_OPTIONS = { timeout: REQUEST_TIMEOUT_MS } as const;
