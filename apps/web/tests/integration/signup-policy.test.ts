import { readFileSync } from "node:fs";
import { PgClient } from "@effect/sql-pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { Deferred, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import {
  accountEligible,
  requireEligibleAccount,
  originatingSessionEligible,
} from "~/modules/auth/server/account-eligibility.ts";
import { Pool } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import {
  account,
  oauthProviders,
  session,
  signupBootstrap,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import {
  addressableByEmailSql,
  verificationRequiredIn,
} from "~/modules/auth/server/account-eligibility.ts";
import { createAppAuth, type AuthMail } from "~/modules/auth/server/config.ts";
import { OAuthRepo } from "~/modules/auth/server/oauth-repo.ts";
import { makeSignupGate } from "~/modules/auth/server/signup-gate.ts";
import { SignupRepo } from "~/modules/auth/server/signup-repo.ts";
import type { AuthSettings, SignupMode } from "~/modules/auth/signup.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");

const origin = "http://localhost:9878";
let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let runtime: ManagedRuntime.ManagedRuntime<OAuthRepo | SignupRepo | Db, unknown>;
let auth: ReturnType<typeof createAppAuth>;

const signups = <A>(f: (r: SignupRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(SignupRepo, f));

let seededPolicy: string | undefined;

const configure = (patch: Partial<AuthSettings>) =>
  signups((repo) =>
    repo.saveSettings({
      passwordSignup: "approval",
      passwordLogin: true,
      requireEmailVerification: false,
      admitDomains: [],
      ...patch,
    }),
  );
let gate: ReturnType<typeof makeSignupGate>;

const makeAuth = (mail?: AuthMail) =>
  createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    signup: gate,
    mail,
  });

const addProvider = (id: string, signup: SignupMode, trustEmails = false, exclusive = false) =>
  runtime.runPromise(
    Effect.flatMap(OAuthRepo, (repo) =>
      repo.upsert({
        id,
        kind: "oidc",
        label: id,
        enabled: true,
        signup,
        trustEmails,
        exclusive,
        clientId: `${id}-client`,
        secret: `${id}-secret`,
        config: { discoveryUrl: "https://id.test/.well-known/openid-configuration", scopes: [] },
      }),
    ),
  );

const signIn = async (email: string) => {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "isolated-test-password-123" }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
};

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
    await pool.query<{ password_signup: string }>(
      "select password_signup from auth_settings where id = 'instance'",
    )
  ).rows[0]?.password_signup;

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
  await configure({ passwordSignup: "approval" });
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
    await configure({ passwordSignup: "closed" });
    expect((await signUp("not-an-admin")).status).toBe(403);
  });

  it("lets the first account in as an approved admin, having nobody to ask", async () => {
    expect((await signUp("founder")).status).toBe(200);
    expect(await statusOf("founder")).toBe("approved");

    const [row] = await db.select().from(user);
    expect(row?.role).toBe("admin");
  });

  it("needs setup until the first account claims the instance, and never again", async () => {
    expect(await signups((repo) => repo.needsSetup())).toBe(true);
    await signUp("founder");
    expect(await signups((repo) => repo.needsSetup())).toBe(false);

    await db.delete(user);
    expect(await signups((repo) => repo.needsSetup())).toBe(false);
  });

  it("creates a later account but leaves it waiting", async () => {
    await signUp("founder");
    expect((await signUp("newcomer")).status).toBe(200);
    expect(await statusOf("newcomer")).toBe("pending");
  });

  it("admits everyone straight away while password signup is open", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "open" });

    await signUp("newcomer");

    expect(await statusOf("newcomer")).toBe("approved");
  });

  it("refuses creation entirely while password signup is closed", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "closed" });

    expect((await signUp("newcomer")).status).not.toBe(200);
    expect(await db.select().from(user)).toHaveLength(1);
  });

  it.each(["open", "closed"] as const)(
    "gives exactly one concurrent first signup the admin claim under %s signup",
    async (policy) => {
      await configure({ passwordSignup: policy });
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
    await configure({ passwordSignup: "closed" });
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

  it("lets an open provider skip the queue while one needing approval waits", async () => {
    await runtime.runPromise(
      Effect.flatMap(OAuthRepo, (repo) =>
        Effect.gen(function* () {
          yield* repo.upsert({
            id: "work",
            kind: "oidc",
            label: "Work",
            enabled: true,
            signup: "open",
            trustEmails: false,
            exclusive: false,
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
            signup: "approval",
            trustEmails: false,
            exclusive: false,
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
    await gate.record({
      userId: colleague,
      providerId: "work",
      email: "x@example.test",
      emailVerified: false,
      isFirstUser: false,
    });
    await gate.record({
      userId: secondColleague,
      providerId: "work",
      email: "x@example.test",
      emailVerified: false,
      isFirstUser: false,
    });
    await gate.record({
      userId: stranger,
      providerId: "github",
      email: "x@example.test",
      emailVerified: false,
      isFirstUser: false,
    });

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
    await configure({ passwordSignup: "open" });
    const newcomer = await insertUser("open-reconciled");
    expect((await signups((repo) => repo.listPending())).map((row) => row.userId)).toContain(
      newcomer,
    );
    await gate.record({
      userId: newcomer,
      providerId: null,
      email: "x@example.test",
      emailVerified: false,
      isFirstUser: false,
    });
    expect(await gate.approved(newcomer)).toBe(true);
  });

  it("promotes a row reconciled while Better Auth’s after-hook is paused", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "open" });
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
    await configure({ passwordSignup: "open" });
    await signUp("first");
    await configure({ passwordSignup: "approval" });
    await signUp("second");

    expect(await statusOf("first")).toBe("approved");
    expect(await statusOf("second")).toBe("pending");
  });
});

describe("each way in", () => {
  const admit = (providerId: string | null, email: string, emailVerified: boolean) =>
    gate.admit({ providerId, email, emailVerified });

  it("closes password registration while a provider still creates accounts", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "closed" });
    await addProvider("work", "open");

    expect((await signUp("newcomer")).status).toBe(403);
    expect(await admit("work", "a@corp.test", true)).toEqual({
      allowed: true,
      emailVerified: true,
    });
  });

  it("closes one provider while password registration stays open", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "open" });
    await addProvider("public", "closed");

    expect((await admit("public", "a@example.test", true)).allowed).toBe(false);
    expect((await admit(null, "a@example.test", false)).allowed).toBe(true);
  });

  it("queues a provider's accounts while refusing password registration", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "closed" });
    await addProvider("sso", "approval");
    const id = await insertUser("queued");

    expect((await admit("sso", "queued@example.test", true)).allowed).toBe(true);
    await gate.record({
      userId: id,
      providerId: "sso",
      email: "queued@example.test",
      emailVerified: true,
      isFirstUser: false,
    });
    expect(await signups((repo) => repo.statusOf(id))).toBe("pending");
    expect((await signUp("password-person")).status).toBe(403);
  });

  it("admits nobody through a provider that is switched off mid-redirect", async () => {
    await signUp("founder");
    await addProvider("gone", "open");
    await runtime.runPromise(Effect.flatMap(OAuthRepo, (repo) => repo.setEnabled("gone", false)));
    expect((await admit("gone", "a@example.test", true)).allowed).toBe(false);
  });

  it("admits anyone while nobody has set the instance up", async () => {
    await addProvider("closed", "closed");
    expect((await admit("closed", "a@example.test", false)).allowed).toBe(true);
  });

  it("raises a trusted provider's emails to verified, and no other's", async () => {
    await signUp("founder");
    await addProvider("corp", "approval", true);
    await addProvider("public", "approval");
    expect((await admit("corp", "a@corp.test", false)).emailVerified).toBe(true);
    expect((await admit("public", "a@example.test", false)).emailVerified).toBe(false);
  });

  it("lets a verified address in a listed domain through a closed provider", async () => {
    await signUp("founder");
    await configure({ admitDomains: ["corp.test"] });
    await addProvider("sso", "closed");
    const id = await insertUser("member");

    expect((await admit("sso", "member@corp.test", true)).allowed).toBe(true);
    expect((await admit("sso", "member@corp.test", false)).allowed).toBe(false);
    expect((await admit("sso", "member@other.test", true)).allowed).toBe(false);
    await gate.record({
      userId: id,
      providerId: "sso",
      email: "member@corp.test",
      emailVerified: true,
      isFirstUser: false,
    });
    expect(await signups((repo) => repo.statusOf(id))).toBe("approved");
  });

  it("ignores listed domains for a password signup nobody can prove", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "closed", admitDomains: ["example.test"] });
    expect((await signUp("typed")).status).toBe(403);
  });

  it("refuses password sign-in when it is off, except to set the instance up", async () => {
    await configure({ passwordLogin: false });
    expect((await signUp("founder")).status).toBe(200);
    expect((await signIn("founder@example.test")).status).toBe(403);
    expect((await signUp("second")).status).toBe(403);

    process.env.AUTH_PASSWORD_LOGIN = "force";
    try {
      expect((await signIn("founder@example.test")).status).toBe(200);
    } finally {
      delete process.env.AUTH_PASSWORD_LOGIN;
    }
  });

  it("refuses unlinking the last provider account while passwords are off", async () => {
    await signUp("founder");
    await addProvider("work", "approval");
    // An account on a provider that is off is no way in, so it does not count.
    await addProvider("old", "approval");
    await runtime.runPromise(Effect.flatMap(OAuthRepo, (repo) => repo.setEnabled("old", false)));
    const [founder] = await db.select().from(user);
    await db.insert(account).values({
      id: uuidv7(),
      accountId: "old-subject",
      providerId: "old",
      userId: founder!.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const linkedId = uuidv7();
    await db.insert(account).values({
      id: linkedId,
      accountId: "work-subject",
      providerId: "work",
      userId: founder!.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { cookie } = await signIn("founder@example.test");
    await configure({ passwordLogin: false });

    const unlink = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ accountId: linkedId }),
      }),
    );
    expect(unlink.status).toBe(403);
    expect(await db.select().from(account).where(eq(account.providerId, "work"))).toHaveLength(1);

    // With passwords back, the same request goes through: the refusal was ours.
    await configure({ passwordLogin: true });
    const allowed = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ accountId: linkedId }),
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await db.select().from(account).where(eq(account.providerId, "work"))).toHaveLength(0);
  });
});

describe("email verification", () => {
  const sent: { to: string; text: string }[] = [];
  const mail: AuthMail = {
    requireVerification: true,
    send: async (to, _subject, { text }) => {
      sent.push({ to, text });
    },
  };
  const linkIn = (text: string) => text.match(/https?:\/\/\S+/)?.[0] ?? "";

  beforeEach(() => {
    sent.length = 0;
  });

  it("holds a password account until the link is opened, then admits a listed domain", async () => {
    await signUp("founder");
    await configure({
      passwordSignup: "closed",
      requireEmailVerification: true,
      admitDomains: ["example.test"],
    });
    auth = makeAuth(mail);

    const created = await signUp("member");
    expect(created.status).toBe(200);
    expect(created.body.token).toBeNull();
    expect(await statusOf("member")).toBe("pending");
    expect((await signIn("member@example.test")).body.code).toBe("EMAIL_NOT_VERIFIED");

    const link = linkIn(sent.find((m) => m.to === "member@example.test")!.text);
    await auth.handler(new Request(link, { headers: { origin } }));

    const [row] = await db.select().from(user).where(eq(user.email, "member@example.test"));
    expect(row?.emailVerified).toBe(true);
    expect(await statusOf("member")).toBe("approved");
    expect((await signIn("member@example.test")).status).toBe(200);
  });

  it("refuses a closed password signup outright instead of promising a link", async () => {
    await signUp("founder");
    await configure({ passwordSignup: "closed", requireEmailVerification: true });
    auth = makeAuth(mail);

    const refused = await signUp("stranger");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("signup_closed");
    expect(sent).toHaveLength(0);
  });

  it("keeps a rejection when the address is proven later", async () => {
    const adminId = (await signUp("founder")).body.user.id as string;
    await configure({ admitDomains: ["example.test"] });
    const id = await insertUser("turned-down");
    await signups((repo) => repo.decide({ userId: id, status: "rejected", decidedBy: adminId }));
    await signups((repo) => repo.markVerified(id));
    expect(await signups((repo) => repo.statusOf(id))).toBe("rejected");
  });

  it("finds unproven addresses by email only while verification is off", async () => {
    await signUp("founder");
    const id = await insertUser("unproven");
    await signups((repo) => repo.record({ userId: id, status: "approved" }));
    const found = async () => {
      const required = await runtime.runPromise(Effect.flatMap(Db, verificationRequiredIn));
      return (
        await db
          .select({ id: user.id })
          .from(user)
          .where(
            sql`${user.email} = 'unproven@example.test' and ${addressableByEmailSql(required)}`,
          )
      ).length;
    };

    expect(await found()).toBe(1);
    await configure({ requireEmailVerification: true });
    expect(await found()).toBe(0);
    process.env.AUTH_PASSWORD_LOGIN = "force";
    try {
      expect(await found()).toBe(1);
    } finally {
      delete process.env.AUTH_PASSWORD_LOGIN;
    }
    await signups((repo) => repo.markVerified(id));
    expect(await found()).toBe(1);
  });

  it("lifts verification everywhere under the operator's override", async () => {
    await signUp("founder");
    await configure({
      passwordSignup: "closed",
      requireEmailVerification: true,
      admitDomains: ["example.test"],
    });
    process.env.AUTH_PASSWORD_LOGIN = "force";
    try {
      // The instance is built as production builds it: no verification under force.
      auth = makeAuth({ ...mail, requireVerification: false });
      // No link will be sent, so a listed domain can no longer prove itself
      // into a closed signup: refused outright, never left waiting.
      const refused = await signUp("member");
      expect(refused.status).toBe(403);
      expect(await statusOf("member")).toBeNull();
      expect(sent).toHaveLength(0);
    } finally {
      delete process.env.AUTH_PASSWORD_LOGIN;
    }
  });
});

describe("a provider that is its accounts' only sign-in", () => {
  const sent: { to: string; text: string }[] = [];
  const mail: AuthMail = {
    requireVerification: false,
    send: async (to, _subject, { text }) => {
      sent.push({ to, text });
    },
  };
  const connect = async (userId: string, providerId: string) => {
    const id = uuidv7();
    await db.insert(account).values({
      id,
      accountId: `${providerId}-${userId}`,
      providerId,
      userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  };

  beforeEach(() => {
    sent.length = 0;
  });

  it("refuses a correct password, and only a correct one learns why", async () => {
    await signUp("founder");
    await signUp("member");
    await addProvider("sso", "approval", false, true);
    const [member] = await db.select().from(user).where(eq(user.email, "member@example.test"));
    await connect(member!.id, "sso");

    const right = await signIn("member@example.test");
    expect(right.status).toBe(403);
    expect(right.body.message).toBe("This account signs in with sso.");
    expect(right.cookie).not.toContain("session_token");

    const wrong = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.test", password: "not-the-password-1" }),
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("lets passwords back in once the provider is switched off", async () => {
    await signUp("founder");
    await signUp("member");
    await addProvider("sso", "approval", false, true);
    const [member] = await db.select().from(user).where(eq(user.email, "member@example.test"));
    await connect(member!.id, "sso");
    await runtime.runPromise(Effect.flatMap(OAuthRepo, (repo) => repo.setEnabled("sso", false)));

    expect((await signIn("member@example.test")).status).toBe(200);
  });

  it("gives an account that only has the provider no password through a reset", async () => {
    await signUp("founder");
    await addProvider("sso", "approval", false, true);
    const id = await insertUser("sso-only");
    await connect(id, "sso");
    auth = makeAuth(mail);

    await auth.handler(
      new Request(`${origin}/api/auth/request-password-reset`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "sso-only@example.test", redirectTo: "/reset-password" }),
      }),
    );
    const token = sent[0]?.text.match(/reset-password\/([^?\s]+)/)?.[1];
    expect(token).toBeTruthy();
    const reset = await auth.handler(
      new Request(`${origin}/api/auth/reset-password`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: "isolated-test-password-123" }),
      }),
    );
    expect(reset.status).not.toBe(200);
    expect(
      await db.select().from(account).where(eq(account.providerId, "credential")),
    ).toHaveLength(1);
    expect((await signIn("sso-only@example.test")).status).not.toBe(200);
  });

  it("opens no session from an emailed verification link", async () => {
    await signUp("founder");
    await addProvider("sso", "approval", false, true);
    const id = await insertUser("sso-only");
    await connect(id, "sso");
    auth = makeAuth(mail);

    await auth.handler(
      new Request(`${origin}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "sso-only@example.test" }),
      }),
    );
    const link = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
    const opened = await auth.handler(new Request(link!, { headers: { origin } }));

    expect(opened.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect(await db.select().from(session).where(eq(session.userId, id))).toHaveLength(0);
  });

  it("still signs in from that link where no provider is exclusive", async () => {
    await signUp("founder");
    await addProvider("sso", "approval");
    const id = await insertUser("bound-nowhere");
    await connect(id, "sso");
    auth = makeAuth(mail);

    await auth.handler(
      new Request(`${origin}/api/auth/send-verification-email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "bound-nowhere@example.test" }),
      }),
    );
    const link = sent[0]?.text.match(/https?:\/\/\S+/)?.[0];
    await auth.handler(new Request(link!, { headers: { origin } }));

    expect(await db.select().from(session).where(eq(session.userId, id))).toHaveLength(1);
  });

  it("lets the operator's override past it", async () => {
    await signUp("founder");
    await signUp("member");
    await addProvider("sso", "approval", false, true);
    const [member] = await db.select().from(user).where(eq(user.email, "member@example.test"));
    await connect(member!.id, "sso");

    process.env.AUTH_PASSWORD_LOGIN = "force";
    try {
      expect((await signIn("member@example.test")).status).toBe(200);
    } finally {
      delete process.env.AUTH_PASSWORD_LOGIN;
    }
  });

  it("can't be disconnected while it is the only sign-in", async () => {
    await signUp("founder");
    await signUp("member");
    await addProvider("sso", "approval", false, true);
    const [member] = await db.select().from(user).where(eq(user.email, "member@example.test"));
    const { cookie } = await signIn("member@example.test");
    const linked = await connect(member!.id, "sso");

    const unlink = await auth.handler(
      new Request(`${origin}/api/auth/unlink-account`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ accountId: linked }),
      }),
    );
    expect(unlink.status).toBe(403);
  });
});

describe("the sign-in methods migration", () => {
  it("gives each way in the policy it replaces, and opens only what trust opened", async () => {
    const migration = readFileSync(
      new URL("../../drizzle/20261020214045_sign_in_methods/migration.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration
      .split("--> statement-breakpoint")
      .filter((statement) => /^\s*(--[^\n]*\n\s*)*UPDATE/.test(statement));
    expect(backfill).toHaveLength(2);
    await pool.query(`ALTER TABLE auth_settings ADD COLUMN signup_policy text`);
    await pool.query(
      `ALTER TABLE oauth_providers ADD COLUMN trusted boolean NOT NULL DEFAULT false`,
    );
    try {
      await addProvider("trusted", "approval");
      await addProvider("plain", "approval");
      await pool.query(`UPDATE oauth_providers SET trusted = true WHERE id = 'trusted'`);
      const modes = async (policy: string) => {
        await pool.query(`UPDATE auth_settings SET signup_policy = $1`, [policy]);
        for (const statement of backfill) await pool.query(statement);
        const { rows } = await pool.query<{ id: string; signup: string }>(
          `SELECT id, signup FROM oauth_providers ORDER BY id`,
        );
        const settings = await signups((repo) => repo.settings());
        return {
          password: settings.passwordSignup,
          ...Object.fromEntries(rows.map((r) => [r.id, r.signup])),
        };
      };
      expect(await modes("approval")).toEqual({
        password: "approval",
        plain: "approval",
        trusted: "open",
      });
      expect(await modes("open")).toEqual({ password: "open", plain: "open", trusted: "open" });
      expect(await modes("closed")).toEqual({
        password: "closed",
        plain: "closed",
        trusted: "closed",
      });
    } finally {
      await pool.query(`ALTER TABLE auth_settings DROP COLUMN signup_policy`);
      await pool.query(`ALTER TABLE oauth_providers DROP COLUMN trusted`);
    }
  });
});

describe("session-free account eligibility", () => {
  const eligible = (id: string) => runtime.runPromise(accountEligible(id));
  const required = (id: string) =>
    runtime.runPromise(
      Effect.flatMap(Db, (client) => client.transaction((tx) => requireEligibleAccount(tx, id))),
    );

  it("repairs only the bootstrap approval and never accepts role as approval", async () => {
    const founder = (await signUp("founder")).body.user.id as string;
    await db.delete(userApprovals).where(eq(userApprovals.userId, founder));
    expect(await eligible(founder)).toBe(true);
    const pending = await insertUser("role-alone");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, pending));
    expect(await eligible(pending)).toBe(false);
    expect(await signups((repo) => repo.statusOf(pending))).toBe("pending");
    await expect(required("missing")).rejects.toMatchObject({
      _tag: "AccountIneligible",
      reason: "missing",
    });
    await expect(required(pending)).rejects.toMatchObject({
      _tag: "AccountIneligible",
      reason: "unapproved",
    });
  });

  it("needs no browser session and distinguishes active from elapsed bans", async () => {
    const id = await insertUser("background");
    await signups((repo) => repo.record({ userId: id, status: "approved" }));
    expect(await db.select().from(session).where(eq(session.userId, id))).toEqual([]);
    expect(await eligible(id)).toBe(true);
    await db.update(user).set({ banned: true, banExpires: null }).where(eq(user.id, id));
    expect(await eligible(id)).toBe(false);
    await expect(required(id)).rejects.toMatchObject({
      _tag: "AccountIneligible",
      reason: "banned",
    });
    await db
      .update(user)
      .set({ banExpires: new Date(Date.now() + 60_000) })
      .where(eq(user.id, id));
    expect(await eligible(id)).toBe(false);
    await db
      .update(user)
      .set({ banExpires: new Date(0) })
      .where(eq(user.id, id));
    expect(await eligible(id)).toBe(true);
    const admin = await insertUser("background-admin");
    await signups((repo) => repo.decide({ userId: id, status: "rejected", decidedBy: admin }));
    expect(await eligible(id)).toBe(false);
    await signups((repo) => repo.decide({ userId: id, status: "approved", decidedBy: admin }));
    expect(await eligible(id)).toBe(true);
  });

  it("pins the exact unexpired originating session and effective user", async () => {
    const id = await insertUser("feed");
    await signups((repo) => repo.record({ userId: id, status: "approved" }));
    const first = uuidv7(),
      second = uuidv7();
    await db.insert(session).values(
      [first, second].map((sid) => ({
        id: sid,
        userId: id,
        token: `synthetic-${sid}`,
        expiresAt: new Date(Date.now() + 60_000),
      })),
    );
    const check = (sid: string, effective = id) =>
      runtime.runPromise(
        Effect.flatMap(Db, (client) =>
          client
            .transaction((tx) => originatingSessionEligible(tx, sid, effective))
            .pipe(Effect.orDie),
        ),
      );
    expect(await check(first)).toBe(true);
    expect(await check(first, "another-person")).toBe(false);
    await db.delete(session).where(eq(session.id, first));
    expect(await check(first)).toBe(false);
    expect(await check(second)).toBe(true);
    await db
      .update(session)
      .set({ expiresAt: new Date(0) })
      .where(eq(session.id, second));
    expect(await check(second)).toBe(false);
  });

  it.each(["rejection", "ban"] as const)(
    "orders acceptance before an overlapping %s",
    async (mutation) => {
      const id = await insertUser(`ordered-${mutation}`);
      const admin = await insertUser(`ordered-${mutation}-admin`);
      await signups((repo) => repo.record({ userId: id, status: "approved" }));
      const entered = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const acceptance = runtime.runPromise(
        Effect.flatMap(Db, (client) =>
          client.transaction((tx) =>
            Effect.gen(function* () {
              yield* requireEligibleAccount(tx, id);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        ),
      );
      await runtime.runPromise(Deferred.await(entered));
      const changed =
        mutation === "rejection"
          ? signups((repo) => repo.decide({ userId: id, status: "rejected", decidedBy: admin }))
          : db.update(user).set({ banned: true }).where(eq(user.id, id)).execute();
      try {
        await runtime.runPromise(
          Effect.tryPromise(() =>
            pool.query<{ blocked: boolean }>(`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
        ) AS blocked
      `),
          ).pipe(Effect.repeat({ until: (result) => result.rows[0]?.blocked === true })),
        );
      } finally {
        await runtime.runPromise(Deferred.succeed(release, undefined));
        await acceptance;
        await changed;
      }
      expect(await eligible(id)).toBe(false);
    },
  );
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

  it("refuses a decision on the decider's own account, and rejecting the owner", async () => {
    const ownerId = (await signUp("founder")).body.user.id as string;
    const other = await insertUser("second-admin");
    await signups((repo) => repo.record({ userId: other, status: "approved" }));
    expect(
      await signups((repo) => repo.decide({ userId: other, status: "rejected", decidedBy: other })),
    ).toBe(false);
    expect(
      await signups((repo) =>
        repo.decide({ userId: ownerId, status: "rejected", decidedBy: other }),
      ),
    ).toBe(false);
    expect(await statusOf("founder")).toBe("approved");
    expect(await runtime.runPromise(accountEligible(other))).toBe(true);
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
