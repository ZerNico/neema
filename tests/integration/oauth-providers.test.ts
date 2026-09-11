import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { PgClient } from "@effect/sql-pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import { oauthProviders } from "~/db/schema/index.ts";
import { createAppAuth, type AuthOAuthProvider } from "~/modules/auth/server/config.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 9).toString("base64");

const origin = "http://localhost:9877";
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let runtime: ManagedRuntime.ManagedRuntime<OAuthRepo | Db, unknown>;

// A local OpenID Connect discovery document. The generic-oauth plugin fetches
// one at init and silently skips any provider whose discovery fails, so a
// registration test has to serve a real one.
let idp: Server;
let idpOrigin: string;

const startIdp = () =>
  new Promise<void>((resolve) => {
    idp = createServer((request, response) => {
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
    secret: "isolated-auth-test-secret-at-least-32-characters",
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

const repo = <A>(f: (r: OAuthRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(OAuthRepo, f));

beforeAll(async () => {
  await startIdp();
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
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
  await container?.stop();
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
