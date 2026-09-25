import { createHash, randomBytes } from "node:crypto";
import { Effect } from "effect";
import { IntegrationRequestFailed } from "../errors.ts";

export const OAUTH_STATE_COOKIE = "integration_oauth_state";
/** Long enough to sign in to the service in a fresh browser, short enough to be useless later. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const base64url = (bytes: Buffer) => bytes.toString("base64url");
export const randomToken = () => base64url(randomBytes(32));
export const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** The path the admin registers with the service; one per integration. */
export const callbackPath = (integrationId: string) =>
  `/api/integrations/${integrationId}/callback`;

export const authorizeUrl = (input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: ReadonlyArray<string>;
  state: string;
  verifier: string;
}) => {
  const url = new URL(input.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", sha256(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export type TokenOutcome = { ok: true; tokens: TokenSet } | { ok: false; revoked: boolean };

/**
 * One token-endpoint call. `revoked` means the grant itself is dead (the person
 * has to reconnect); anything else is a transient failure worth retrying later.
 */
export const requestTokens = (input: {
  endpoint: string;
  clientId: string;
  clientSecret: string | null;
  params: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const body = new URLSearchParams({ ...input.params, client_id: input.clientId });
    if (input.clientSecret) body.set("client_secret", input.clientSecret);
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(input.endpoint, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body,
        }),
      catch: () =>
        new IntegrationRequestFailed({
          status: null,
          message: "The sign-in server could not be reached.",
        }),
    });
    const json: Record<string, unknown> = yield* Effect.tryPromise({
      try: () => response.json() as Promise<Record<string, unknown>>,
      catch: () =>
        new IntegrationRequestFailed({
          status: response.status,
          message: `The sign-in server answered ${response.status} without JSON.`,
        }),
    });
    if (!response.ok || typeof json.access_token !== "string") {
      const error = typeof json.error === "string" ? json.error : "";
      const description = typeof json.error_description === "string" ? json.error_description : "";
      const revoked =
        error === "invalid_grant" ||
        error === "invalid_client" ||
        error === "unauthorized_client" ||
        // Outline names a spent or unknown refresh token `invalid_request`
        // with "Invalid grant: …", where the spec says `invalid_grant`.
        (error === "invalid_request" && /^invalid grant\b/i.test(description)) ||
        response.status === 401;
      const failed: TokenOutcome = { ok: false, revoked };
      return failed;
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;
    const issued: TokenOutcome = {
      ok: true,
      tokens: {
        accessToken: json.access_token,
        refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
        expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
      },
    };
    return issued;
  });
