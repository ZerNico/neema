import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  IssuerMismatchError,
  OAuthError,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { IntegrationRejected } from "../../errors.ts";
import type { DiscoveredOAuth } from "../../server/adapter.ts";
import { reachesPublicOnly } from "../manifest.ts";
import type { TokenOutcome, TokenSet } from "../../server/oauth.ts";
import { scopedFetch } from "./http.ts";

const reject = (reason: string) => new IntegrationRejected({ reason });

/** A sign-in request ends with its caller, or on its own after this long. */
const OAUTH_TIMEOUT_MS = 30_000;

/**
 * Requests for one step of a sign-in. Refreshing holds the connection's row
 * lock, so a stalled authorization server must not hold it for long.
 */
const bounded = (url: URL, signal: AbortSignal, publicOnly: boolean) =>
  scopedFetch(url, {
    publicOnly,
    signal: AbortSignal.any([signal, AbortSignal.timeout(OAUTH_TIMEOUT_MS)]),
  });

/**
 * Metadata stored at sign-in, read back. It was the SDK's validated document
 * when stored; this only confirms it still has what a token request needs.
 */
const storedMetadata = (record: Readonly<Record<string, unknown>>) => {
  const text = (key: string) => typeof record[key] === "string";
  if (!text("issuer") || !text("authorization_endpoint") || !text("token_endpoint"))
    throw new Error("The stored sign-in metadata is incomplete.");
  return record as AuthorizationServerMetadata;
};

const words = (value: string | undefined | null) => (value ?? "").split(/\s+/).filter(Boolean);

const union = (...lists: ReadonlyArray<ReadonlyArray<string>>) => [...new Set(lists.flat())];

/** A canonical resource URI: no fragment, no trailing slash unless it is the whole path. */
const canonical = (url: URL) => {
  const copy = new URL(url);
  copy.hash = "";
  const text = copy.toString();
  return text.endsWith("/") && copy.pathname !== "/" ? text.slice(0, -1) : text.replace(/\/$/, "");
};

const tokensOf = (tokens: OAuthTokens): TokenSet => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token ?? null,
  expiresAt: typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : null,
});

/** Grant errors that mean the person has to sign in again; anything else may pass. */
const REVOKED = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 200) : "unknown error";

/**
 * Asks the server unauthenticated, as the spec's flow starts: a protected
 * server answers 401 with where its metadata is and which scopes it wants.
 */
const challenge = (url: URL, publicOnly: boolean) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await bounded(
        url,
        signal,
        publicOnly,
      )(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "neema", version: "1.0.0" },
          },
        }),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status === 401 ? extractWWWAuthenticateParams(response) : null;
    },
    catch: () => reject("The MCP server could not be reached."),
  });

/**
 * Whether a server that refused a request without an account says where to sign
 * in, safely enough to use: an authorization server with PKCE. Otherwise it
 * takes a token pasted from the person's account there. Signing in, it says
 * how a client may come to exist there without someone registering an app.
 */
export const offersSignIn = (config: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const url = new URL(config.url!);
    const publicOnly = reachesPublicOnly(config);
    const hint = yield* challenge(url, publicOnly);
    const info = yield* Effect.tryPromise({
      try: (signal) =>
        discoverOAuthServerInfo(url, {
          fetchFn: bounded(url, signal, publicOnly),
          ...(hint?.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}),
        }),
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    const metadata = info?.authorizationServerMetadata;
    return {
      signIn: Boolean(metadata?.code_challenge_methods_supported?.includes("S256")),
      registers: Boolean(metadata?.registration_endpoint),
      metadataDocuments: metadata?.client_id_metadata_document_supported === true,
    };
  });

export const mcpOAuth: DiscoveredOAuth = {
  begin: (input) =>
    Effect.gen(function* () {
      const url = new URL(input.config.url!);
      const publicOnly = reachesPublicOnly(input.config);
      const hint = yield* challenge(url, publicOnly);
      const info = yield* Effect.tryPromise({
        try: (signal) =>
          discoverOAuthServerInfo(url, {
            fetchFn: bounded(url, signal, publicOnly),
            ...(hint?.resourceMetadataUrl ? { resourceMetadataUrl: hint.resourceMetadataUrl } : {}),
          }),
        catch: (error) => reject(`Could not find the server’s sign-in: ${messageOf(error)}`),
      });
      const metadata = info.authorizationServerMetadata;
      if (!metadata)
        return yield* reject(
          hint
            ? "The server asks for sign-in but does not say where. Ask its operator for an OAuth setup, or use a token."
            : "This server does not ask anyone to sign in. Choose “No sign-in” for it.",
        );
      // PKCE is not optional here: without S256 the code could be redeemed by whoever saw it.
      if (!metadata.code_challenge_methods_supported?.includes("S256"))
        return yield* reject(
          "The server’s sign-in does not support PKCE, so it is not safe to use.",
        );
      // The page people sign in on and the endpoint tokens come from both need
      // HTTPS, unless they are the server itself, which the admin chose.
      const insecure = [metadata.authorization_endpoint, metadata.token_endpoint].some(
        (endpoint) => {
          const address = new URL(endpoint);
          return address.protocol !== "https:" && address.origin !== url.origin;
        },
      );
      if (insecure) return yield* reject("The server’s sign-in does not use HTTPS.");

      // The resource the tokens are bound to: what the server says it is, as
      // long as that is the address configured, else the address itself.
      const advertised = info.resourceMetadata?.resource;
      const resource = advertised && URL.canParse(advertised) ? new URL(advertised) : null;
      if (
        resource &&
        (resource.origin !== url.origin || !url.pathname.startsWith(resource.pathname))
      )
        return yield* reject(
          "The server’s sign-in names another server as itself, so it was not used.",
        );
      const resourceUri = canonical(resource ?? resourceUrlFromServerUrl(url));

      const requested = words(input.config.scopes);
      const base = requested.length
        ? requested
        : hint?.scope
          ? words(hint.scope)
          : (info.resourceMetadata?.scopes_supported ?? []);
      const offline = metadata.scopes_supported?.includes("offline_access")
        ? ["offline_access"]
        : [];
      const scopes = union(base, input.scopes.granted, input.scopes.required, offline);

      const issuer = metadata.issuer;
      const client = yield* clientFor(input, metadata, url);
      const started = yield* Effect.tryPromise({
        try: () =>
          startAuthorization(issuer, {
            metadata,
            clientInformation: {
              client_id: client.clientId,
              ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
            },
            redirectUrl: input.redirectUri,
            ...(scopes.length ? { scope: scopes.join(" ") } : {}),
            state: input.state,
            resource: new URL(resourceUri),
          }),
        catch: (error) => reject(`Could not start the sign-in: ${messageOf(error)}`),
      });
      return {
        url: started.authorizationUrl.toString(),
        verifier: started.codeVerifier,
        server: {
          issuer,
          metadata: { ...metadata },
          resource: resourceUri,
          clientId: client.clientId,
          scopes,
        },
      };
    }),

  complete: (input) =>
    Effect.tryPromise({
      try: (signal) =>
        exchangeAuthorization(input.server.issuer, {
          metadata: storedMetadata(input.server.metadata),
          clientInformation: {
            client_id: input.server.clientId,
            ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
          },
          authorizationCode: input.code,
          // Checked against the issuer recorded at the start (RFC 9207) before the code leaves.
          ...(input.iss === null ? {} : { iss: input.iss }),
          codeVerifier: input.verifier,
          redirectUri: input.redirectUri,
          resource: new URL(input.server.resource),
          fetchFn: bounded(new URL(input.server.resource), signal, reachesPublicOnly(input.config)),
        }),
      catch: (error) =>
        error instanceof IssuerMismatchError || /\biss\b|issuer/i.test(messageOf(error))
          ? reject("The sign-in came back from another server than it went to, so it was not used.")
          : reject("The server refused the sign-in. Try again."),
    }).pipe(Effect.map(tokensOf)),

  refresh: (input) =>
    Effect.tryPromise({
      try: (signal) =>
        refreshAuthorization(input.server.issuer, {
          metadata: storedMetadata(input.server.metadata),
          clientInformation: {
            client_id: input.server.clientId,
            ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
          },
          refreshToken: input.refreshToken,
          resource: new URL(input.server.resource),
          fetchFn: bounded(new URL(input.server.resource), signal, reachesPublicOnly(input.config)),
        }),
      catch: (error) => error,
    }).pipe(
      Effect.map((tokens): TokenOutcome => ({ ok: true, tokens: tokensOf(tokens) })),
      Effect.catch((error) =>
        Effect.succeed<TokenOutcome>({
          ok: false,
          revoked: error instanceof OAuthError && REVOKED.has(String(error.code)),
        }),
      ),
    ),
};

/**
 * The client to sign in as, in the spec's order: one the admin registered,
 * one registered before with this issuer, a metadata document this app
 * serves, else a dynamic registration remembered for the issuer.
 */
const clientFor = (
  input: Parameters<DiscoveredOAuth["begin"]>[0],
  metadata: AuthorizationServerMetadata,
  url: URL,
) =>
  Effect.gen(function* () {
    const admin = input.preregistered;
    if (admin) {
      // The admin registered it with one authorization server. If the MCP server
      // later names another, its secret must not go there.
      const pinned = yield* admin.pin(metadata.issuer);
      if (pinned !== metadata.issuer)
        return yield* reject(
          `The server now signs in through ${metadata.issuer}, not ${pinned ?? "the server"} where your admin’s client ID was set up. Ask your admin to check it.`,
        );
      return { clientId: admin.clientId, clientSecret: admin.clientSecret };
    }
    const stored = yield* input.storedClient(metadata.issuer);
    if (stored) return stored;
    if (input.clientMetadataUrl && metadata.client_id_metadata_document_supported === true)
      return { clientId: input.clientMetadataUrl, clientSecret: null };
    if (!metadata.registration_endpoint)
      return yield* reject(
        reachesPublicOnly(input.config)
          ? "The server’s sign-in only accepts registered apps. Use a token instead."
          : "The server’s sign-in only accepts registered apps. Ask your admin to add a client ID for it.",
      );
    // The method the token request will use (the SDK prefers basic, then post),
    // so the client is registered for how it then authenticates. Silence means basic (RFC 8414).
    const supported = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    const method = supported.includes("client_secret_basic")
      ? "client_secret_basic"
      : supported.includes("client_secret_post")
        ? "client_secret_post"
        : "none";
    const registered = yield* Effect.tryPromise({
      try: (signal) =>
        registerClient(metadata.issuer, {
          metadata,
          clientMetadata: {
            client_name: `neema · ${input.integrationName}`,
            redirect_uris: [input.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: method,
            application_type: "web",
          },
          fetchFn: bounded(url, signal, reachesPublicOnly(input.config)),
        }),
      catch: (error) =>
        reject(`The server’s sign-in refused to register this app: ${messageOf(error)}`),
    });
    const client = {
      clientId: registered.client_id,
      clientSecret: registered.client_secret ?? null,
      method: "dynamic" as const,
      redirectUri: input.redirectUri,
    };
    yield* input.saveClient(metadata.issuer, client);
    return client;
  });
