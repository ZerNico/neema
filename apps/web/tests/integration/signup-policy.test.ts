import { readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import { oauthProviders, signupBootstrap, user, userApprovals } from "~/db/schema/index.ts";
import { createAppAuth } from "~/modules/auth/server/config.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { makeSignupGate } from "~/modules/auth/server/signup-gate.ts";
import { SignupRepo } from "~/modules/auth/server/signup-repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 11).toString("base64");

const origin = "http://localhost:9878";
let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let runtime: ManagedRuntime.ManagedRuntime<OAuthRepo | SignupRepo | Db, unknown>;
let auth: ReturnType<typeof createAppAuth>;

const signups = <A>(f: (r: SignupRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(SignupRepo, f));

let seededPolicy: string | undefined;
let gate: ReturnType<typeof makeSignupGate>;

const makeAuth = () =>
  createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    signup: gate,
  });

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

const signInAndRequestDesktop = async (name: string) => {
  const login = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: `${name}@example.test`,
        password: "isolated-test-password-123",
      }),
    }),
  );
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const desktop = await auth.handler(
    new Request(`${origin}/api/auth/desktop/ticket`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: "{}",
    }),
  );
  const devices = await auth.handler(
    new Request(`${origin}/api/auth/desktop/devices`, { headers: { origin, cookie } }),
  );
  return { login: login.status, desktop: desktop.status, devices: devices.status };
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
  database = await createTestDatabase();
  const url = database.url;
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

  gate = makeSignupGate((effect) => runtime.runPromise(effect));
  auth = makeAuth();
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await db.delete(user);
  await db.delete(signupBootstrap);
  await db.delete(oauthProviders);
  await signups((repo) => repo.setPolicy("approval"));
  auth = makeAuth();
});

describe("who gets an account", () => {
  it("ships set to approval, so an upgraded instance stops admitting strangers", () => {
    expect(seededPolicy).toBe("approval");
  });

  it("seeds existing users and approvals in the upgrade without electing a missing admin", async () => {
    const originalAdmin = await insertUser("legacy-admin");
    const other = await insertUser("legacy-other");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, originalAdmin));
    await signups((repo) => repo.record({ userId: other, status: "rejected" }));
    const migration = readFileSync(
      new URL("../../drizzle/20260924122445_premium_banshee/migration.sql", import.meta.url),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint");
    for (const statement of statements.slice(1, 3)) await pool.query(statement);
    expect((await db.select().from(signupBootstrap))[0]?.ownerId).toBe(originalAdmin);
    expect(await signups((repo) => repo.statusOf(originalAdmin))).toBe("approved");
    expect(await signups((repo) => repo.statusOf(other))).toBe("rejected");

    await db.delete(user);
    await db.delete(signupBootstrap);
    const unclaimed = await insertUser("legacy-no-admin");
    for (const statement of statements.slice(1, 3)) await pool.query(statement);
    expect((await db.select().from(signupBootstrap))[0]?.ownerId).toBe("legacy-no-admin");
    expect(await signups((repo) => repo.statusOf(unclaimed))).toBe("approved");
    await signups((repo) => repo.setPolicy("closed"));
    expect((await signUp("not-an-admin")).status).toBe(403);
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

  it.each(["open", "closed"] as const)(
    "gives exactly one concurrent first signup the admin claim under %s policy",
    async (policy) => {
      await signups((repo) => repo.setPolicy(policy));
      const results = await Promise.all([signUp("first"), signUp("second")]);
      const rows = await db.select().from(user);
      const owners = rows.filter((row) => row.role === "admin");
      const [claim] = await db.select().from(signupBootstrap);
      expect(owners).toHaveLength(1);
      expect(claim?.ownerId).toBe(owners[0]?.id);
      expect(results.filter((result) => result.status === 200)).toHaveLength(
        policy === "open" ? 2 : 1,
      );
      expect(rows).toHaveLength(policy === "open" ? 2 : 1);
    },
  );

  it("reserves a failed pre-insert claim until an operator repairs it", async () => {
    await pool.query(`CREATE FUNCTION reject_first_signup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test rejects insert'; END $$`);
    await pool.query(`CREATE TRIGGER reject_first_signup BEFORE INSERT ON "user"
      FOR EACH ROW EXECUTE FUNCTION reject_first_signup()`);
    try {
      expect((await signUp("first")).status).toBe(422);
    } finally {
      await pool.query(`DROP TRIGGER reject_first_signup ON "user"`);
      await pool.query(`DROP FUNCTION reject_first_signup()`);
    }
    const [claim] = await db.select().from(signupBootstrap);
    expect(claim?.ownerId).toBeTruthy();
    expect(await db.select().from(user)).toHaveLength(0);
    await signups((repo) => repo.setPolicy("closed"));
    expect((await signUp("next")).status).toBe(403);
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("repairs the bootstrap approval after an after-hook failure", async () => {
    auth = createAppAuth({
      db,
      baseURL: origin,
      secret: "isolated-auth-test-secret-at-least-32-characters",
      purgeUserFiles: async () => {},
      signup: {
        ...gate,
        record: async () => {
          throw new Error("lost approval write");
        },
      },
    });
    await signUp("founder").catch(() => {});
    const [founder] = await db.select().from(user);
    expect(founder?.role).toBe("admin");
    expect(await db.select().from(userApprovals)).toHaveLength(0);
    expect(await gate.approved(founder!.id)).toBe(true);
    expect(await statusOf("founder")).toBe("approved");
    expect(await signInAndRequestDesktop("founder")).toEqual({
      login: 200,
      desktop: 200,
      devices: 200,
    });
  });

  it("denies and reconciles a later account whose after-hook failed", async () => {
    await signUp("founder");
    auth = createAppAuth({
      db,
      baseURL: origin,
      secret: "isolated-auth-test-secret-at-least-32-characters",
      purgeUserFiles: async () => {},
      signup: {
        ...gate,
        record: async () => {
          throw new Error("lost approval write");
        },
      },
    });
    await signUp("missing").catch(() => {});
    const [missing] = await db.select().from(user).where(eq(user.email, "missing@example.test"));
    expect(missing?.role).toBe("user");
    expect(
      await db.select().from(userApprovals).where(eq(userApprovals.userId, missing!.id)),
    ).toHaveLength(0);
    expect(await signInAndRequestDesktop("missing")).toEqual({
      login: 200,
      desktop: 403,
      devices: 403,
    });
    expect(await gate.approved(missing!.id)).toBe(false);
    expect(await statusOf("missing")).toBe("pending");
    expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).toContain(
      missing!.id,
    );
  });

  it("lets administrators see other missing rows without overwriting a decision", async () => {
    const adminId = (await signUp("founder")).body.user.id as string;
    const missingId = await insertUser("missing");
    const rejectedId = await insertUser("rejected");
    await signups((repo) => repo.record({ userId: rejectedId, status: "rejected" }));
    const pending = await signups((repo) => repo.listPending());
    expect(pending.map((row) => row.userId)).toContain(missingId);
    expect(await signups((repo) => repo.statusOf(rejectedId))).toBe("rejected");
    await signups((repo) =>
      repo.decide({ userId: missingId, status: "approved", decidedBy: adminId }),
    );
    expect(await gate.approved(missingId)).toBe(true);
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
    const secondColleague = await insertUser("second-colleague");
    const stranger = await insertUser("stranger");

    expect(await signups((repo) => repo.statusOf(colleague))).toBe("pending");
    expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).toContain(
      secondColleague,
    );
    await gate.record({ userId: colleague, providerId: "work", isFirstUser: false });
    await gate.record({ userId: secondColleague, providerId: "work", isFirstUser: false });
    await gate.record({ userId: stranger, providerId: "github", isFirstUser: false });

    expect(await signups((repo) => repo.statusOf(colleague))).toBe("approved");
    expect(await signups((repo) => repo.statusOf(secondColleague))).toBe("approved");
    expect(await gate.approved(colleague)).toBe(true);
    expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).not.toContain(
      secondColleague,
    );
    expect(await signups((repo) => repo.statusOf(stranger))).toBe("pending");
  });

  it("keeps an administrator’s decision when a late approval arrives", async () => {
    const adminId = (await signUp("founder")).body.user.id as string;
    for (const decision of ["approved", "rejected"] as const) {
      const userId = await insertUser(`late-${decision}`);
      await signups((repo) => repo.statusOf(userId));
      await signups((repo) => repo.decide({ userId, status: decision, decidedBy: adminId }));
      const before = (
        await db.select().from(userApprovals).where(eq(userApprovals.userId, userId))
      )[0]!;
      await signups((repo) => repo.record({ userId, status: "approved" }));
      const after = (
        await db.select().from(userApprovals).where(eq(userApprovals.userId, userId))
      )[0]!;
      expect(after).toEqual(before);
    }
  });

  it("promotes a reconciled account when open signup records approval", async () => {
    await signUp("founder");
    await signups((repo) => repo.setPolicy("open"));
    const newcomer = await insertUser("open-reconciled");
    expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).toContain(
      newcomer,
    );
    await gate.record({ userId: newcomer, providerId: null, isFirstUser: false });
    expect(await gate.approved(newcomer)).toBe(true);
  });

  it("promotes a row reconciled while Better Auth’s after-hook is paused", async () => {
    await signUp("founder");
    await signups((repo) => repo.setPolicy("open"));
    const entered = Effect.runSync(Deferred.make<string>());
    const release = Effect.runSync(Deferred.make<void>());
    auth = createAppAuth({
      db,
      baseURL: origin,
      secret: "isolated-auth-test-secret-at-least-32-characters",
      purgeUserFiles: async () => {},
      signup: {
        ...gate,
        record: async (input) => {
          await runtime.runPromise(Deferred.succeed(entered, input.userId));
          await runtime.runPromise(Deferred.await(release));
          await gate.record(input);
        },
      },
    });
    const signup = signUp("racing");
    try {
      const userId = await runtime.runPromise(Deferred.await(entered));
      expect(await signups((repo) => repo.statusOf(userId))).toBe("pending");
      await runtime.runPromise(Deferred.succeed(release, undefined));
      expect((await signup).status).toBe(200);
      expect(await signups((repo) => repo.statusOf(userId))).toBe("approved");
      expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).not.toContain(
        userId,
      );
    } finally {
      await runtime.runPromise(Deferred.succeed(release, undefined));
      await signup;
    }
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
