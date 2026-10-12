import { createServer, type Server } from "node:http";
import { PgClient } from "@effect/sql-pg";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import { account, oauthProviders } from "~/db/schema/index.ts";
import { createAppAuth, type AuthOAuthProvider } from "~/modules/auth/server/config.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

const origin = "http://localhost:9877";
const authSecret = "isolated-auth-test-secret-at-least-32-characters";
let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let runtime: ManagedRuntime.ManagedRuntime<OAuthRepo | Db, unknown>;

// A local OpenID Connect discovery document. The generic-oauth plugin fetches
// one at init and silently skips any provider whose discovery fails, so a
// registration test has to serve a real one.
let idp: Server;
let idpOrigin: string;
let subject = "synthetic-user";
let tokens = { access: "synthetic-access", refresh: "synthetic-refresh" };
let receivedRefreshTokens: string[] = [];

const startIdp = () =>
  new Promise<void>((resolve) => {
    idp = createServer((request, response) => {
      if (request.url === "/token") {
        request.setEncoding("utf8");
        let body = "";
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const params = new URLSearchParams(body);
          if (params.get("grant_type") === "refresh_token") {
            receivedRefreshTokens.push(params.get("refresh_token") ?? "");
          }
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              access_token: tokens.access,
              refresh_token: tokens.refresh,
              token_type: "Bearer",
              expires_in: 3600,
              scope: "openid email",
            }),
          );
        });
        return;
      }
      if (request.url === "/userinfo") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            sub: subject,
            email: `${subject}@example.invalid`,
            email_verified: true,
            name: "Synthetic User",
          }),
        );
        return;
      }
      if (request.url !== "/.well-known/openid-configuration") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer: idpOrigin,
          authorization_endpoint: `${idpOrigin}/authorize`,
          token_endpoint: `${idpOrigin}/token`,
          userinfo_endpoint: `${idpOrigin}/userinfo`,
          jwks_uri: `${idpOrigin}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
    });
    idp.listen(0, "127.0.0.1", () => {
      const address = idp.address();
      idpOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });

const authWith = (providers: readonly AuthOAuthProvider[]) =>
  createAppAuth({
    db,
    baseURL: origin,
    secret: authSecret,
    purgeUserFiles: async () => {},
    oauthProviders: providers,
  });

const signInSocial = async (auth: ReturnType<typeof createAppAuth>, provider: string) => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/" }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const completeOAuth = async (
  auth: ReturnType<typeof createAppAuth>,
  provider: string,
  sessionCookie = "",
) => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/${sessionCookie ? "link-social" : "sign-in/social"}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ provider, callbackURL: "/" }),
    }),
  );
  expect(response.status).toBe(200);
  const { url } = await response.json();
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const callback = await auth.handler(
    new Request(`${origin}/api/auth/callback/${provider}?code=synthetic-code&state=${state}`, {
      headers: { cookie: [sessionCookie, cookie].filter(Boolean).join("; ") },
    }),
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
  return callback.headers
    .getSetCookie()
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";")[0])
    .join("; ");
};

const repo = <A>(f: (r: OAuthRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(OAuthRepo, f));

beforeAll(async () => {
  await startIdp();
  database = await createTestDatabase();
  const url = database.url;
  pool = new Pool({ connectionString: url });
  db = drizzle({ client: pool, relations });
  runtime = ManagedRuntime.make(
    OAuthRepo.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(Db.layer, KeyCipher.layer)),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
    ),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await database?.drop();
  await new Promise<void>((resolve) => idp.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(oauthProviders);
});

const google = {
  id: "google",
  kind: "builtin" as const,
  label: "Google",
  enabled: true,
  trusted: false,
  clientId: "google-client",
  config: {},
};

describe("OAuth provider storage", () => {
  it("encrypts the client secret, keeps it off public rows and hands it back decrypted", async () => {
    await repo((r) => r.upsert({ ...google, secret: "first-secret" }));

    const [row] = await db.select().from(oauthProviders);
    expect(row?.clientSecretCiphertext).toBeTruthy();
    expect(row?.clientSecretCiphertext).not.toContain("first-secret");

    const [published] = await repo((r) => r.list());
    expect(published).toMatchObject({ id: "google", secretConfigured: true });
    expect(published).not.toHaveProperty("clientSecretCiphertext");

    expect(await repo((r) => r.listForAuth())).toEqual([
      {
        kind: "builtin",
        id: "google",
        clientId: "google-client",
        clientSecret: "first-secret",
        tenantId: undefined,
        issuer: undefined,
      },
    ]);
  });

  it("keeps the stored secret when a save omits it and replaces it when one is given", async () => {
    await repo((r) => r.upsert({ ...google, secret: "first-secret" }));

    await repo((r) => r.upsert({ ...google, clientId: "renamed-client" }));
    let [configured] = await repo((r) => r.listForAuth());
    expect(configured).toMatchObject({ clientId: "renamed-client", clientSecret: "first-secret" });

    await repo((r) => r.upsert({ ...google, clientId: "renamed-client", secret: "second-secret" }));
    [configured] = await repo((r) => r.listForAuth());
    expect(configured).toMatchObject({ clientSecret: "second-secret" });
  });

  it("registers neither a disabled provider nor one with no secret stored", async () => {
    await repo((r) => r.upsert({ ...google, enabled: false, secret: "first-secret" }));
    await repo((r) => r.upsert({ ...google, id: "github", label: "GitHub" }));

    expect(await repo((r) => r.list())).toHaveLength(2);
    expect(await repo((r) => r.listForAuth())).toEqual([]);
    expect(await repo((r) => r.listForSignIn())).toEqual([{ id: "github", label: "GitHub" }]);
  });

  it("drops a provider it can no longer configure rather than failing every sign-in", async () => {
    await repo((r) =>
      r.upsert({
        id: "acme",
        kind: "oidc",
        label: "Acme",
        enabled: true,
        trusted: false,
        clientId: "acme-client",
        secret: "acme-secret",
        config: { scopes: ["openid"] },
      }),
    );
    await repo((r) => r.upsert({ ...google, secret: "first-secret" }));

    // The OIDC row has no discovery URL, so only the built-in survives.
    expect(await repo((r) => r.listForAuth())).toMatchObject([{ id: "google" }]);
  });

  it("turns a provider on without disturbing what else is stored", async () => {
    await repo((r) => r.upsert({ ...google, enabled: false, secret: "first-secret" }));

    await repo((r) => r.setEnabled("google", true));

    expect((await repo((r) => r.list()))[0]).toMatchObject({
      enabled: true,
      clientId: "google-client",
      secretConfigured: true,
    });
    expect(await repo((r) => r.listForAuth())).toMatchObject([{ clientSecret: "first-secret" }]);
  });

  it("removes a provider", async () => {
    await repo((r) => r.upsert({ ...google, secret: "first-secret" }));
    await repo((r) => r.remove("google"));
    expect(await repo((r) => r.list())).toEqual([]);
  });
});

describe("native OAuth token storage", () => {
  it.each(["opaque", "hex"])(
    "encrypts %s tokens through callbacks, linking and refresh",
    async (format) => {
      subject = `synthetic-${format}`;
      receivedRefreshTokens = [];
      const providers: AuthOAuthProvider[] = ["acme", "other"].map((id) => ({
        kind: "oidc",
        id,
        label: id,
        clientId: "acme-client",
        clientSecret: "acme-secret",
        discoveryUrl: `${idpOrigin}/.well-known/openid-configuration`,
        scopes: ["openid", "email"],
      }));
      const tokenPair = (revision: number) => ({
        access: format === "hex" ? "ab".repeat(32) + `0${revision}` : `access-${revision}`,
        refresh: format === "hex" ? "cd".repeat(32) + `0${revision}` : `refresh-${revision}`,
      });
      const stored = async (providerId: string) => {
        const [current] = await db
          .select()
          .from(account)
          .where(and(eq(account.accountId, subject), eq(account.providerId, providerId)));
        assert(current, "OAuth callback must persist the account");
        expect(current.accessToken).toBeTruthy();
        expect(current.refreshToken).toBeTruthy();
        expect(current.accessToken).not.toBe(tokens.access);
        expect(current.refreshToken).not.toBe(tokens.refresh);
        expect(await symmetricDecrypt({ key: authSecret, data: current.accessToken! })).toBe(
          tokens.access,
        );
        expect(await symmetricDecrypt({ key: authSecret, data: current.refreshToken! })).toBe(
          tokens.refresh,
        );
        return current;
      };

      let auth = authWith(providers);
      tokens = tokenPair(1);
      let cookie = await completeOAuth(auth, "acme");
      const initial = await stored("acme");

      tokens = tokenPair(2);
      cookie = await completeOAuth(auth, "acme");
      expect((await stored("acme")).id).toBe(initial.id);

      tokens = tokenPair(3);
      await completeOAuth(auth, "other", cookie);
      const linked = await stored("other");
      expect(linked.userId).toBe(initial.userId);

      // A fresh instance has only the secret and database, not the callback's tokens.
      auth = authWith(providers);
      const headers = new Headers({ cookie, origin });
      expect(
        await auth.api.getAccessToken({ body: { accountId: linked.id }, headers }),
      ).toMatchObject({ accessToken: tokens.access });
      const previousRefresh = tokens.refresh;
      tokens = tokenPair(4);
      expect(
        await auth.api.refreshToken({ body: { accountId: linked.id }, headers }),
      ).toMatchObject({ accessToken: tokens.access, refreshToken: tokens.refresh });
      expect(receivedRefreshTokens).toEqual([previousRefresh]);
      await stored("other");
    },
  );
});

describe("provider registration in the auth instance", () => {
  it("offers sign-in only for the providers it was built with", async () => {
    const withGoogle = await signInSocial(
      authWith([
        { kind: "builtin", id: "google", clientId: "google-client", clientSecret: "google-secret" },
      ]),
      "google",
    );
    expect(withGoogle.status).toBe(200);
    expect(new URL(withGoogle.body.url).host).toBe("accounts.google.com");

    const without = await signInSocial(authWith([]), "google");
    expect(without.status).not.toBe(200);
  });

  it("registers an OpenID Connect provider under its own id, reachable the same way", async () => {
    const auth = authWith([
      {
        kind: "oidc",
        id: "acme",
        label: "Acme",
        clientId: "acme-client",
        clientSecret: "acme-secret",
        discoveryUrl: `${idpOrigin}/.well-known/openid-configuration`,
        scopes: ["openid", "email"],
      },
    ]);

    const result = await signInSocial(auth, "acme");
    expect(result.status).toBe(200);
    const url = new URL(result.body.url);
    expect(url.origin + url.pathname).toBe(`${idpOrigin}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("acme-client");
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/acme`);
    expect(url.searchParams.get("scope")?.split(" ")).toContain("email");
  });
});
