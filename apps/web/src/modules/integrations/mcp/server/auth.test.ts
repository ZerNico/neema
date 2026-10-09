import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Duration, Effect, Exit } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredServer, StoredOAuthClient } from "../../server/repo.ts";
import { mcpOAuth } from "./auth.ts";

/** What the authorization server saw, to check what this app sent it. */
const log = {
  registrations: [] as Array<Record<string, unknown>>,
  tokens: [] as Array<Record<string, string>>,
  /** Requests to the token endpoint that never answers, and how many the client gave up. */
  stalled: 0,
  abandoned: 0,
};
let metadataExtras: Record<string, unknown> = {};

let server: Server;
let base: string;

const json = (response: ServerResponse, status: number, body: unknown, headers = {}) =>
  response
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));

/**
 * An MCP server and its authorization server on one origin, as many are:
 * a 401 with the protected resource metadata, RFC 8414 metadata, dynamic
 * registration, and a token endpoint that binds tokens to the resource.
 */
const serve = async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const path = new URL(request.url ?? "/", base).pathname;
  if (path === "/stall") {
    log.stalled++;
    response.on("close", () => void log.abandoned++);
    return;
  }
  if (path === "/mcp")
    return response
      .writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="files:read"`,
      })
      .end();
  if (path === "/.well-known/oauth-protected-resource/mcp")
    return json(response, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ["files:read", "files:write"],
    });
  if (path === "/.well-known/oauth-authorization-server")
    return json(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["files:read", "files:write", "offline_access"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      authorization_response_iss_parameter_supported: true,
      ...metadataExtras,
    });
  if (path === "/register") {
    const registration = JSON.parse(body) as Record<string, unknown>;
    log.registrations.push(registration);
    return json(response, 201, {
      ...registration,
      client_id: "dyn-client",
      client_secret: "dyn-secret",
    });
  }
  if (path === "/token") {
    const form = Object.fromEntries(new URLSearchParams(body));
    log.tokens.push({ ...form, authorization: request.headers.authorization ?? "" });
    if (form.resource !== `${base}/mcp`) return json(response, 400, { error: "invalid_target" });
    if (form.grant_type === "authorization_code" && form.code === "good" && form.code_verifier)
      return json(response, 200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
      });
    if (form.grant_type === "refresh_token" && form.refresh_token === "refresh-1")
      return json(response, 200, {
        access_token: "access-2",
        expires_in: 3600,
        token_type: "Bearer",
      });
    return json(response, 400, { error: "invalid_grant" });
  }
  response.writeHead(404).end();
};

beforeAll(async () => {
  server = createServer((request, response) => void serve(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  log.registrations.length = 0;
  log.tokens.length = 0;
  log.stalled = 0;
  log.abandoned = 0;
  metadataExtras = {};
});

const begin = (options: {
  stored?: StoredOAuthClient | null;
  preregistered?: { clientId: string; clientSecret: string | null; pinned: string | null } | null;
  clientMetadataUrl?: string | null;
  required?: string[];
  scopes?: string;
}) => {
  const saved: Array<[string, StoredOAuthClient]> = [];
  const run = Effect.runPromiseExit(
    mcpOAuth.begin({
      config: {
        url: `${base}/mcp`,
        auth: "oauth",
        ...(options.scopes ? { scopes: options.scopes } : {}),
      },
      integrationId: "mcp",
      integrationName: "Files",
      redirectUri: "https://chat.example.com/api/integrations/mcp/callback",
      clientMetadataUrl: options.clientMetadataUrl ?? null,
      state: "state-1",
      scopes: { granted: [], required: options.required ?? [] },
      preregistered: options.preregistered
        ? {
            clientId: options.preregistered.clientId,
            clientSecret: options.preregistered.clientSecret,
            pin: (issuer) => Effect.succeed(options.preregistered!.pinned ?? issuer),
          }
        : null,
      storedClient: () => Effect.succeed(options.stored ?? null),
      saveClient: (issuer, client) => Effect.sync(() => void saved.push([issuer, client])),
    }),
  );
  return run.then((exit) => ({ exit, saved }));
};

const started = async (options: Parameters<typeof begin>[0] = {}) => {
  const { exit, saved } = await begin(options);
  if (!Exit.isSuccess(exit)) throw new Error(JSON.stringify(exit));
  return { ...exit.value, saved, url: new URL(exit.value.url) };
};

describe("signing in to an MCP server", () => {
  it("finds the sign-in from the server's challenge, registers once and asks with PKCE for this resource", async () => {
    const { url, server: found, saved, verifier } = await started();
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "dyn-client",
      redirect_uri: "https://chat.example.com/api/integrations/mcp/callback",
      code_challenge_method: "S256",
      state: "state-1",
      resource: `${base}/mcp`,
    });
    // The challenge's scope is what the call needs, plus a refresh token when offered.
    expect(url.searchParams.get("scope")).toBe("files:read offline_access");
    expect(verifier.length).toBeGreaterThan(40);
    expect(log.registrations).toEqual([
      expect.objectContaining({
        client_name: "neema · Files",
        redirect_uris: ["https://chat.example.com/api/integrations/mcp/callback"],
        token_endpoint_auth_method: "client_secret_basic",
        application_type: "web",
      }),
    ]);
    expect(saved).toEqual([
      [
        base,
        {
          clientId: "dyn-client",
          clientSecret: "dyn-secret",
          method: "dynamic",
          redirectUri: "https://chat.example.com/api/integrations/mcp/callback",
        },
      ],
    ]);
    expect(found).toMatchObject({ issuer: base, resource: `${base}/mcp`, clientId: "dyn-client" });
  });

  it("asks again for what a call lacked, keeping what was granted", async () => {
    const { url } = await started({ required: ["files:write"] });
    expect(url.searchParams.get("scope")).toBe("files:read files:write offline_access");
  });

  it("uses the admin's client, or one registered before, without registering again", async () => {
    const admin = await started({
      preregistered: { clientId: "admin-client", clientSecret: "x", pinned: null },
    });
    expect(admin.url.searchParams.get("client_id")).toBe("admin-client");
    // Its pin lives with the integration; no registration is touched.
    expect(admin.saved).toEqual([]);
    const again = await started({
      stored: {
        clientId: "dyn-client",
        clientSecret: "dyn-secret",
        method: "dynamic",
        redirectUri: "https://chat.example.com/api/integrations/mcp/callback",
      },
    });
    expect(again.url.searchParams.get("client_id")).toBe("dyn-client");
    expect(log.registrations).toEqual([]);
  });

  it("never sends the admin's client to an issuer other than the one it was first used with", async () => {
    const moved = await begin({
      preregistered: {
        clientId: "admin-client",
        clientSecret: "x",
        pinned: "https://idp.example.com",
      },
    });
    expect(Exit.isFailure(moved.exit)).toBe(true);
    expect(JSON.stringify(moved.exit)).toMatch(/now signs in through/);
    const same = await started({
      preregistered: { clientId: "admin-client", clientSecret: "x", pinned: base },
    });
    expect(same.saved).toEqual([]);
  });

  it("prefers a client metadata document where the server reads them", async () => {
    metadataExtras = { client_id_metadata_document_supported: true };
    const { url, saved } = await started({
      clientMetadataUrl: "https://chat.example.com/api/integrations/mcp/oauth-client",
    });
    expect(url.searchParams.get("client_id")).toBe(
      "https://chat.example.com/api/integrations/mcp/oauth-client",
    );
    expect(log.registrations).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("refuses a sign-in page or token endpoint elsewhere without HTTPS", async () => {
    for (const key of ["authorization_endpoint", "token_endpoint"]) {
      metadataExtras = { [key]: "http://login.example.com/oauth" };
      const { exit } = await begin({});
      expect(JSON.stringify(exit), key).toContain("does not use HTTPS");
    }
  });

  it("refuses a sign-in without PKCE", async () => {
    metadataExtras = { code_challenge_methods_supported: ["plain"] };
    const { exit } = await begin({});
    expect(JSON.stringify(exit)).toContain("PKCE");
  });

  describe("finishing", () => {
    const finish = (found: DiscoveredServer, verifier: string, iss: string | null) =>
      Effect.runPromiseExit(
        mcpOAuth.complete({
          server: found,
          clientSecret: "dyn-secret",
          code: "good",
          iss,
          verifier,
          redirectUri: "https://chat.example.com/api/integrations/mcp/callback",
        }),
      );

    it("redeems the code for tokens bound to the resource when the right server answers", async () => {
      const { server: found, verifier } = await started();
      const exit = await finish(found, verifier, base);
      expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
        accessToken: "access-1",
        refreshToken: "refresh-1",
      });
      expect(log.tokens.at(-1)).toMatchObject({
        grant_type: "authorization_code",
        resource: `${base}/mcp`,
        code_verifier: verifier,
      });
      // A confidential client authenticates in the header, not the body.
      expect(log.tokens.at(-1)!.authorization).toMatch(/^Basic /);
    });

    it("registers for the client authentication the token request then uses", async () => {
      metadataExtras = { token_endpoint_auth_methods_supported: ["client_secret_post"] };
      const { server: found, verifier } = await started();
      expect(log.registrations.at(-1)).toMatchObject({
        token_endpoint_auth_method: "client_secret_post",
      });
      await finish(found, verifier, base);
      expect(log.tokens.at(-1)).toMatchObject({ client_secret: "dyn-secret", authorization: "" });
    });

    it("never spends the code when another server answered, or none said who it was", async () => {
      const { server: found, verifier } = await started();
      const mixedUp = await finish(found, verifier, "https://evil.example.com");
      const silent = await finish(found, verifier, null);
      expect(Exit.isFailure(mixedUp)).toBe(true);
      expect(Exit.isFailure(silent)).toBe(true);
      expect(log.tokens.filter((entry) => entry.grant_type === "authorization_code")).toEqual([]);
    });
  });

  it("refreshes for the same resource, and a refused grant means signing in again", async () => {
    const { server: found } = await started();
    const fresh = await Effect.runPromise(
      mcpOAuth.refresh({ server: found, clientSecret: "dyn-secret", refreshToken: "refresh-1" }),
    );
    expect(fresh).toMatchObject({ ok: true, tokens: { accessToken: "access-2" } });
    expect(log.tokens.at(-1)).toMatchObject({
      grant_type: "refresh_token",
      resource: `${base}/mcp`,
    });
    const revoked = await Effect.runPromise(
      mcpOAuth.refresh({ server: found, clientSecret: "dyn-secret", refreshToken: "spent" }),
    );
    expect(revoked).toEqual({ ok: false, revoked: true });
  });

  it("gives up a refresh it stopped waiting for, rather than leave the request open", async () => {
    const { server: found } = await started();
    const stalling = { ...found, metadata: { ...found.metadata, token_endpoint: `${base}/stall` } };
    const outcome = await Effect.runPromise(
      mcpOAuth
        .refresh({ server: stalling, clientSecret: "dyn-secret", refreshToken: "refresh-1" })
        .pipe(Effect.timeoutOption(Duration.millis(300))),
    );
    expect(outcome._tag).toBe("None");
    expect(log.stalled).toBe(1);
    await vi.waitFor(() => expect(log.abandoned).toBe(1));
  });
});
