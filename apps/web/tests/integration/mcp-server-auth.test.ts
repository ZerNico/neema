import { PgClient } from "@effect/sql-pg";
import {
  auth as authorize,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  signupBootstrap,
  user,
} from "~/db/schema/index.ts";
import { createAppAuth } from "~/modules/auth/server/config.ts";
import { ConnectedApps } from "~/modules/mcp-server/server/connected-apps.ts";
import { mcpEndpoint } from "~/modules/mcp-server/server/endpoint.ts";
import { signInRedirect } from "~/modules/mcp-server/server/sign-in-redirect.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const origin = "http://localhost:9879";
const resource = `${origin}/api/mcp`;
const redirectUri = "http://127.0.0.1:9999/cb";

let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let auth: ReturnType<typeof createAppAuth>;
let runtime: ManagedRuntime.ManagedRuntime<ConnectedApps | Db, never>;
/** The `mcp` capability and approval, as `mayConnectApps` would answer. */
let allowed = true;

/** The routes an MCP client reaches, as the app serves them. */
let serveMcp: (request: Request) => Promise<Response>;
const route = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/auth") || path.startsWith("/.well-known/"))
    return auth.handler(request);
  if (path === "/api/mcp") return serveMcp(request);
  return new Response("Not found", { status: 404 });
};

/** A signed-in browser: one cookie jar, sending what a page would. */
class Browser {
  cookies = new Map<string, string>();
  async request(path: string, init: { method?: string; body?: object } = {}) {
    const response = await auth.handler(
      new Request(new URL(path, origin), {
        method: init.method ?? (init.body ? "POST" : "GET"),
        redirect: "manual",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

/** What an MCP client keeps between runs, in memory. */
class Provider implements OAuthClientProvider {
  info: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  get redirectUrl() {
    return redirectUri;
  }
  /** No `application_type`, as Cursor and older Claude Code send it. */
  get clientMetadata() {
    return {
      client_name: "Test Client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ connectionString: database.url });
  db = drizzle({ client: pool, relations });
  runtime = ManagedRuntime.make(
    ConnectedApps.layer.pipe(
      Layer.provideMerge(Db.layer),
      Layer.provide(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 3 })),
      Layer.orDie,
    ),
  );
  serveMcp = mcpEndpoint({
    resource,
    grantFor: (token) => auth.api.verifyMcpToken({ body: { token } }),
    allowed: async () => allowed,
    // This suite calls no tools; those are tests/integration/mcp-server-tools.test.ts.
    run: () => Promise.reject(new Error("no tools are called here")),
    stateKey: new Uint8Array(32),
  });
  auth = createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    mcp: {
      resource,
      allowed: async () => allowed,
      fetchClientMetadata: async () => new Response(null, { status: 404 }),
    },
  });
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await database?.drop();
});

let browser: Browser;
let userId: string;

beforeEach(async () => {
  allowed = true;
  await db.delete(oauthClient);
  await db.delete(user);
  await db.delete(signupBootstrap);
  browser = new Browser();
  const signup = await browser.request("/api/auth/sign-up/email", {
    body: { name: "Nico", email: "nico@example.test", password: "isolated-test-password-123" },
  });
  expect(signup.status).toBe(200);
  userId = ((await signup.json()) as { user: { id: string } }).user.id;
});

/**
 * The browser half of authorization: the server sends a signed-in person to
 * consent, and consent answers with where the browser goes next.
 */
const consent = async (authorizationUrl: URL, scope?: string) => {
  const authorized = await browser.request(authorizationUrl.pathname + authorizationUrl.search);
  expect(authorized.status).toBe(302);
  const page = new URL(authorized.headers.get("location")!, origin);
  expect(page.pathname).toBe("/oauth/consent");
  return browser.request("/api/auth/oauth2/consent", {
    body: { accept: true, oauth_query: page.search.slice(1), ...(scope ? { scope } : {}) },
  });
};

/** Discovery, registration, consent and token exchange, through the SDK's own client flow. */
const connectApp = async (scope?: string) => {
  const provider = new Provider();
  expect(await authorize(provider, { serverUrl: resource, fetchFn: route })).toBe("REDIRECT");
  const decided = await consent(provider.authorizationUrl!, scope);
  expect(decided.status).toBe(200);
  const callback = new URL(((await decided.json()) as { url: string }).url);
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  const iss = callback.searchParams.get("iss");
  const result = await authorize(provider, {
    serverUrl: resource,
    authorizationCode: callback.searchParams.get("code")!,
    ...(iss ? { iss } : {}),
    fetchFn: route,
  });
  expect(result).toBe("AUTHORIZED");
  return provider;
};

const mcpClient = async (provider: Provider, mode: "auto" | "legacy") => {
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: route }),
  );
  return client;
};

const bearer = (token: string, headers: Record<string, string> = {}) =>
  route(resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    }),
  });

const refresh = (provider: Provider) =>
  route(`${origin}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: provider.saved!.refresh_token!,
      client_id: provider.info!.client_id,
    }).toString(),
  });

/**
 * The same registered app asking again, as it does once its tokens are gone.
 * The SDK always sends `prompt=consent` with `offline_access`; dropped here so
 * what the server decides on its own is what gets tested.
 */
const askAgain = async (provider: Provider) => {
  const again = new Provider();
  again.info = provider.info;
  expect(await authorize(again, { serverUrl: resource, fetchFn: route })).toBe("REDIRECT");
  const url = new URL(again.authorizationUrl!);
  url.searchParams.delete("prompt");
  const authorized = await browser.request(url.pathname + url.search);
  expect(authorized.status).toBe(302);
  return { again, location: new URL(authorized.headers.get("location")!, origin) };
};

describe("MCP authorization", () => {
  it("publishes discovery for the endpoint and its authorization server", async () => {
    const resourceMetadata = await route(`${origin}/.well-known/oauth-protected-resource/api/mcp`);
    expect(await resourceMetadata.json()).toMatchObject({
      resource,
      authorization_servers: [`${origin}/api/auth`],
    });
    const server = await route(`${origin}/.well-known/oauth-authorization-server/api/auth`);
    const metadata = (await server.json()) as Record<string, unknown>;
    expect(metadata["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata["client_id_metadata_document_supported"]).toBe(true);
    const challenge = await route(resource, { method: "POST", body: "{}" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  it("connects an app through discovery and consent, on both protocol eras", async () => {
    const provider = await connectApp();
    const modern = await mcpClient(provider, "auto");
    expect(modern.getProtocolEra()).toBe("modern");
    expect(modern.getServerVersion()?.name).toBe("neema");
    await modern.close();
    const legacy = await mcpClient(provider, "legacy");
    expect(legacy.getProtocolEra()).toBe("legacy");
    await legacy.close();
  });

  it("binds tokens to the endpoint and keeps them past the browser session", async () => {
    const provider = await connectApp();
    const grant = await auth.api.verifyMcpToken({
      body: { token: provider.saved!.access_token },
    });
    expect(grant?.userId).toBe(userId);
    expect(grant?.audience).toContain(resource);
    // The provider treats a token as dead once its session expires and copies
    // the session onto refreshed tokens; neither may end the app's access.
    await db.update(session).set({ expiresAt: sql`now() - interval '1 hour'` });
    expect((await bearer(provider.saved!.access_token)).status).toBe(200);
    const refreshed = await refresh(provider);
    expect(refreshed.status).toBe(200);
    const { access_token } = (await refreshed.json()) as { access_token: string };
    expect((await bearer(access_token)).status).toBe(200);
    const [browserSession] = await db.select({ id: session.id }).from(session);
    await db.update(oauthAccessToken).set({ sessionId: browserSession!.id });
    expect(
      await db.select().from(oauthAccessToken).where(isNotNull(oauthAccessToken.sessionId)),
    ).toEqual([]);
    expect(
      await db.select().from(oauthRefreshToken).where(isNotNull(oauthRefreshToken.sessionId)),
    ).toEqual([]);
  });

  it("never signs anyone out from a link, and marks a fresh sign-in for the page to ask", async () => {
    const provider = await connectApp();
    const signedIn = async () =>
      (await browser.request("/api/auth/get-session").then((r) => r.json())) !== null;
    const visit = (path: string) => {
      const response = signInRedirect(new Request(new URL(path, origin)));
      expect(response.status).toBe(302);
      expect(response.headers.getSetCookie()).toEqual([]);
      return new URL(response.headers.get("location")!, origin);
    };
    // Another site's link, asking for a sign-in nobody signed: marked, and nothing ends.
    const forged = visit(`/oauth/sign-in?prompt=login&client_id=${provider.info!.client_id}`);
    expect(forged.searchParams.get("fresh")).toBe("1");
    expect(await signedIn()).toBe(true);
    // The provider's own request for a newer sign-in reaches the page the same way.
    const again = new Provider();
    again.info = provider.info;
    expect(await authorize(again, { serverUrl: resource, fetchFn: route })).toBe("REDIRECT");
    const url = new URL(again.authorizationUrl!);
    url.searchParams.set("prompt", "login");
    const authorized = await browser.request(url.pathname + url.search);
    const page = new URL(authorized.headers.get("location")!, origin);
    expect(page.pathname).toBe("/oauth/sign-in");
    const continued = visit(page.pathname + page.search);
    expect(continued.pathname).toBe("/oauth/continue");
    expect(continued.searchParams.get("fresh")).toBe("1");
    expect(await signedIn()).toBe(true);
    // Without prompt=login there is nothing to ask.
    expect(visit(`/oauth/sign-in?client_id=x`).searchParams.has("fresh")).toBe(false);
  });

  it("grants only the scopes the person kept at consent", async () => {
    const provider = await connectApp("chats:read offline_access");
    expect(provider.saved?.scope).toBe("chats:read offline_access");
    const [stored] = await db.select().from(oauthConsent).where(eq(oauthConsent.userId, userId));
    expect(stored?.scopes).toEqual(["chats:read", "offline_access"]);
  });

  it("refuses a cookie without a token, and a page from another origin", async () => {
    const cookie = [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    const cookieOnly = await route(resource, { method: "POST", headers: { cookie }, body: "{}" });
    expect(cookieOnly.status).toBe(401);
    const provider = await connectApp();
    const foreign = await bearer(provider.saved!.access_token, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const same = await bearer(provider.saved!.access_token, { origin });
    expect(same.status).toBe(200);
  });

  it("ends access on the next request once the account may not connect apps", async () => {
    const provider = await connectApp();
    allowed = false;
    expect((await bearer(provider.saved!.access_token)).status).toBe(401);
    // Its consent is still stored, which alone would hand out a code again.
    const { location } = await askAgain(provider);
    expect(location.pathname).toBe("/oauth/consent");
    expect(location.searchParams.get("prompt")).toBe("consent");
    const refused = await browser.request("/api/auth/oauth2/consent", {
      body: { accept: true, oauth_query: location.search.slice(1) },
    });
    expect(refused.status).toBe(403);
  });

  it("ends access at once when the person disconnects the app", async () => {
    const provider = await connectApp();
    const [app] = await runtime.runPromise(ConnectedApps.use((apps) => apps.list(userId)));
    expect(app?.name).toBe("Test Client");
    await runtime.runPromise(ConnectedApps.use((apps) => apps.revoke(userId, app!.clientId)));
    expect((await bearer(provider.saved!.access_token)).status).toBe(401);
    expect((await refresh(provider)).status).toBe(400);
    expect(await runtime.runPromise(ConnectedApps.use((apps) => apps.list(userId)))).toEqual([]);
  });

  it("voids a code handed out before the person disconnected", async () => {
    const provider = await connectApp();
    const { again, location } = await askAgain(provider);
    expect(location.origin + location.pathname).toBe(redirectUri);
    const exchange = () =>
      authorize(again, {
        serverUrl: resource,
        authorizationCode: location.searchParams.get("code")!,
        iss: location.searchParams.get("iss")!,
        fetchFn: route,
      });
    await runtime.runPromise(
      ConnectedApps.use((apps) => apps.revoke(userId, provider.info!.client_id)),
    );
    await expect(exchange()).rejects.toThrow(/invalid_grant|code/i);
    expect(await db.select().from(oauthAccessToken)).toEqual([]);
  });
});
