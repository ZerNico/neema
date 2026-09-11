import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import { oauthProviders, user, userApprovals } from "~/db/schema/index.ts";
import { createAppAuth } from "~/modules/auth/server/config.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { makeSignupGate } from "~/modules/auth/server/signup-gate.ts";
import { SignupRepo } from "~/modules/auth/server/signup-repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 11).toString("base64");

const origin = "http://localhost:9878";
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let runtime: ManagedRuntime.ManagedRuntime<OAuthRepo | SignupRepo | Db, unknown>;
let auth: ReturnType<typeof createAppAuth>;

const signups = <A>(f: (r: SignupRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(SignupRepo, f));

let seededPolicy: string | undefined;

const insertUser = async (name: string) => {
  const id = uuidv7();
  const now = new Date();
  await db.insert(user).values({
    id,
    name,
    email: `${name}@example.test`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

const signUp = async (name: string) => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email: `${name}@example.test`,
        password: "isolated-test-password-123",
      }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const statusOf = async (name: string) => {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.email, `${name}@example.test`));
  if (!row) return null;
  return signups((repo) => repo.statusOf(row.id));
};

beforeAll(async () => {
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
    Layer.mergeAll(OAuthRepo.layer, SignupRepo.layer).pipe(
      Layer.provideMerge(Layer.mergeAll(Db.layer, KeyCipher.layer)),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
    ),
  );
  // Read before any test touches it: beforeEach sets a policy, so the seed the
  // migration wrote has to be captured while it is still the only one.
  seededPolicy = (
    await pool.query<{ signup_policy: string }>(
      "select signup_policy from auth_settings where id = 'instance'",
    )
  ).rows[0]?.signup_policy;

  auth = createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    // The gate production wires into the same factory, on this runtime.
    signup: makeSignupGate((effect) => runtime.runPromise(effect)),
  });
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(user);
  await db.delete(oauthProviders);
  await signups((repo) => repo.setPolicy("approval"));
});

describe("who gets an account", () => {
  it("ships set to approval, so an upgraded instance stops admitting strangers", () => {
    expect(seededPolicy).toBe("approval");
  });

  it("lets the first account in as an approved admin, having nobody to ask", async () => {
    expect((await signUp("founder")).status).toBe(200);
    expect(await statusOf("founder")).toBe("approved");

    const [row] = await db.select().from(user);
    expect(row?.role).toBe("admin");
  });

  it("creates a later account but leaves it waiting", async () => {
    await signUp("founder");
    expect((await signUp("newcomer")).status).toBe(200);
    expect(await statusOf("newcomer")).toBe("pending");
  });

  it("admits everyone straight away while the policy is open", async () => {
    await signUp("founder");
    await signups((repo) => repo.setPolicy("open"));

    await signUp("newcomer");

    expect(await statusOf("newcomer")).toBe("approved");
  });

  it("refuses creation entirely while the policy is closed", async () => {
    await signUp("founder");
    await signups((repo) => repo.setPolicy("closed"));

    expect((await signUp("newcomer")).status).not.toBe(200);
    expect(await db.select().from(user)).toHaveLength(1);
  });

  it("lets a trusted provider skip the queue while an untrusted one waits", async () => {
    const gate = makeSignupGate((effect) => runtime.runPromise(effect));
    await runtime.runPromise(
      Effect.flatMap(OAuthRepo, (repo) =>
        Effect.gen(function* () {
          yield* repo.upsert({
            id: "work",
            kind: "oidc",
            label: "Work",
            enabled: true,
            trusted: true,
            clientId: "work-client",
            secret: "work-secret",
            config: {
              discoveryUrl: "https://id.test/.well-known/openid-configuration",
              scopes: [],
            },
          });
          yield* repo.upsert({
            id: "github",
            kind: "builtin",
            label: "GitHub",
            enabled: true,
            trusted: false,
            clientId: "gh-client",
            secret: "gh-secret",
            config: {},
          });
        }),
      ),
    );
    // Inserted rather than signed up, because an email signup would already
    // have asked the gate and the approval row is written once.
    const colleague = await insertUser("colleague");
    const stranger = await insertUser("stranger");

    await gate.record({ userId: colleague, providerId: "work", isFirstUser: false });
    await gate.record({ userId: stranger, providerId: "github", isFirstUser: false });

    expect(await signups((repo) => repo.statusOf(colleague))).toBe("approved");
    expect(await signups((repo) => repo.statusOf(stranger))).toBe("pending");
  });

  it("takes effect on the next signup, not the next restart", async () => {
    await signUp("founder");
    await signups((repo) => repo.setPolicy("open"));
    await signUp("first");
    await signups((repo) => repo.setPolicy("approval"));
    await signUp("second");

    expect(await statusOf("first")).toBe("approved");
    expect(await statusOf("second")).toBe("pending");
  });
});

describe("an admin deciding on a waiting account", () => {
  it("lets an approved account through and keeps a declined one on file", async () => {
    const adminId = (await signUp("founder")).body.user.id as string;
    await signUp("wanted");
    await signUp("unwanted");
    const idOf = async (name: string) =>
      (
        await db
          .select()
          .from(user)
          .where(eq(user.email, `${name}@example.test`))
      )[0]!.id;

    expect(await signups((repo) => repo.listPending())).toHaveLength(2);

    const wantedId = await idOf("wanted");
    const unwantedId = await idOf("unwanted");
    await signups((repo) =>
      repo.decide({ userId: wantedId, status: "approved", decidedBy: adminId }),
    );
    await signups((repo) =>
      repo.decide({ userId: unwantedId, status: "rejected", decidedBy: adminId }),
    );

    expect(await signups((repo) => repo.listPending())).toEqual([]);
    expect(await statusOf("wanted")).toBe("approved");
    // Kept, so the same person cannot sign up again and reappear in the queue.
    expect(await statusOf("unwanted")).toBe("rejected");
  });

  it("drops the approval row with the account it belongs to", async () => {
    await signUp("founder");
    await signUp("newcomer");
    const [row] = await db.select().from(user).where(eq(user.email, "newcomer@example.test"));

    await db.delete(user).where(eq(user.id, row!.id));

    expect(await db.select().from(userApprovals).where(eq(userApprovals.userId, row!.id))).toEqual(
      [],
    );
  });
});
