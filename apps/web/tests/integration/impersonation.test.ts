import { PgClient } from "@effect/sql-pg";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { relations } from "~/db/relations.ts";
import { session, signupBootstrap, user, userApprovals } from "~/db/schema/index.ts";
import { accountEligible } from "~/modules/auth/server/account-eligibility.ts";
import { createAppAuth, type ImpersonationEvent } from "~/modules/auth/server/config.ts";
import { Db } from "~/server/db.ts";
import { projectSessionIdentity } from "~/modules/auth/identity.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const origin = "http://localhost:9876";
let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let auth: ReturnType<typeof createAppAuth>;
let runtime: ManagedRuntime.ManagedRuntime<Db, unknown>;
const logs: ImpersonationEvent[] = [];
const logger = vi.fn(async (event: ImpersonationEvent) => {
  logs.push(event);
});

class Browser {
  cookies = new Map<string, string>();
  async request(path: string, body?: object) {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const index = pair.indexOf("=");
      const name = pair.slice(0, index),
        value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async signup(name: string) {
    const result = await this.request("/sign-up/email", {
      name,
      email: `${name}@example.test`,
      password: "isolated-test-password-123",
    });
    expect(result.status).toBe(200);
    return result.body.user.id as string;
  }
  identity() {
    return this.request("/get-session");
  }
  start(userId: string) {
    return this.request("/admin/impersonate-user", { userId });
  }
  stop() {
    return this.request("/admin/stop-impersonating", {});
  }
}
let admin: Browser, target: Browser, other: Browser;
let adminId: string, targetId: string, otherId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  pool = new Pool({ connectionString: url });
  db = drizzle({ client: pool, relations });
  runtime = ManagedRuntime.make(
    Db.layer.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 3 })),
    ),
  );
  auth = createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    signup: {
      admit: async ({ emailVerified }) => ({ allowed: true, emailVerified }),
      verified: async () => {},
      passwordAllowed: async () => true,
      keepsWayIn: async () => true,
      record: async ({ userId }) => {
        await db.insert(userApprovals).values({ userId, status: "approved" });
      },
      // The production predicate, so bans and approvals are judged as they are live.
      approved: (userId) => runtime.runPromise(accountEligible(userId)),
    },
    log: logger,
  });
}, 120_000);
afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await database?.drop();
});
beforeEach(async () => {
  await db.delete(user);
  await db.delete(signupBootstrap);
  logs.length = 0;
  logger.mockClear();
  admin = new Browser();
  target = new Browser();
  other = new Browser();
  adminId = await admin.signup("admin");
  targetId = await target.signup("target");
  otherId = await other.signup("other");
});

describe("native administrator eligibility", () => {
  const endpoints = [
    ["/admin/set-role", { role: "admin" }],
    ["/admin/get-user", null],
    [
      "/admin/create-user",
      { name: "Created", email: "created@example.test", password: "isolated-password-123" },
    ],
    ["/admin/update-user", { data: { name: "Changed" } }],
    ["/admin/list-users", null],
    ["/admin/list-user-sessions", {}],
    ["/admin/unban-user", {}],
    ["/admin/ban-user", {}],
    ["/admin/impersonate-user", {}],
    ["/admin/revoke-user-session", { sessionToken: "synthetic" }],
    ["/admin/revoke-user-sessions", {}],
    ["/admin/remove-user", {}],
    ["/admin/set-user-password", { newPassword: "isolated-password-123" }],
    ["/admin/has-permission", { permissions: { user: ["list"] } }],
  ] as const;

  it.each(["pending", "rejected"] as const)(
    "denies every privileged endpoint to an %s admin",
    async (status) => {
      await db.update(userApprovals).set({ status }).where(eq(userApprovals.userId, adminId));
      for (const [path, body] of endpoints) {
        const requestPath = path === "/admin/get-user" ? `${path}?id=${targetId}` : path;
        // oxlint-disable-next-line eslint/no-await-in-loop -- Check each real native endpoint against the same suspended actor.
        const response = await admin.request(
          requestPath,
          body === null ? undefined : { ...body, userId: targetId },
        );
        expect(response.status, path).toBe(403);
      }
      expect((await admin.request("/sign-out", {})).status).toBe(200);
    },
  );

  it("checks the original actor while impersonating and allows restoration without privileged access", async () => {
    expect((await admin.start(targetId)).status).toBe(200);
    await db.update(user).set({ role: "admin" }).where(eq(user.id, targetId));
    await db
      .update(userApprovals)
      .set({ status: "rejected" })
      .where(eq(userApprovals.userId, adminId));
    expect((await admin.request(`/admin/get-user?id=${otherId}`)).status).toBe(403);
    expect((await admin.stop()).status).toBe(200);
    expect((await admin.identity()).body.user.id).toBe(adminId);
    expect((await admin.request(`/admin/get-user?id=${otherId}`)).status).toBe(403);
    expect((await admin.request("/sign-out", {})).status).toBe(200);
  });

  it("denies an active ban even if a session row survives, and permits an elapsed ban", async () => {
    await db.update(user).set({ banned: true, banExpires: null }).where(eq(user.id, adminId));
    expect((await admin.request(`/admin/get-user?id=${targetId}`)).status).toBe(403);
    await db
      .update(user)
      .set({ banExpires: new Date(0) })
      .where(eq(user.id, adminId));
    expect((await admin.request(`/admin/get-user?id=${targetId}`)).status).toBe(200);
  });
});

describe("native impersonation through the production handler configuration", () => {
  it("uses first-signup admin, one-hour temporary sessions, native restoration and credential-free logs/projection", async () => {
    const original = (await admin.identity()).body;
    expect(original.user.role).toBe("admin");
    expect((await target.identity()).body.user.role).toBe("user");
    const started = await admin.start(targetId);
    expect(started.status).toBe(200);
    const active = (await admin.identity()).body;
    expect(projectSessionIdentity(active)).toEqual({
      userId: targetId,
      impersonatedBy: adminId,
      sessionId: active.session.id,
    });
    const duration =
      new Date(active.session.expiresAt).getTime() - new Date(active.session.createdAt).getTime();
    expect(duration).toBeGreaterThanOrEqual(3_599_000);
    expect(duration).toBeLessThanOrEqual(3_601_000);
    expect((await admin.stop()).status).toBe(200);
    expect((await admin.identity()).body.session.id).toBe(original.session.id);
    expect(await db.select().from(session).where(eq(session.id, active.session.id))).toEqual([]);
    expect(logs).toEqual([
      { action: "impersonation.start", actorId: adminId, targetId, timestamp: expect.any(String) },
      { action: "impersonation.stop", actorId: adminId, targetId, timestamp: expect.any(String) },
    ]);
    const safe = JSON.stringify({ logs, identity: projectSessionIdentity(active) });
    expect(safe).not.toContain(active.session.token);
    expect(safe).not.toContain(original.session.token);
    expect(Object.keys(projectSessionIdentity(active)!)).toEqual([
      "userId",
      "impersonatedBy",
      "sessionId",
    ]);
  });

  it("rejects nonadmins, self, admins, banned users and missing targets without success logs", async () => {
    expect((await target.start(otherId)).status).toBe(403);
    expect((await admin.start(adminId)).status).toBe(403);
    await db.update(user).set({ role: "admin" }).where(eq(user.id, otherId));
    expect((await admin.start(otherId)).status).toBe(403);
    await db.update(user).set({ banned: true }).where(eq(user.id, targetId));
    expect((await admin.start(targetId)).status).toBeGreaterThanOrEqual(400);
    expect((await admin.start("missing")).status).toBe(404);
    expect((await admin.stop()).status).toBe(400);
    expect(logs).toEqual([]); // Includes endpoint APIErrors processed by after hooks.
  });

  it("rejects nested starts even after the effective user is promoted", async () => {
    expect((await admin.start(targetId)).status).toBe(200);
    expect((await admin.start(otherId)).status).toBe(403);
    await db.update(user).set({ role: "admin" }).where(eq(user.id, targetId));
    expect((await admin.start(otherId)).status).toBe(403);
    expect(logs).toHaveLength(1);
    expect((await admin.stop()).status).toBe(200);
    expect(projectSessionIdentity((await admin.identity()).body)).toEqual({
      userId: adminId,
      impersonatedBy: null,
      sessionId: expect.any(String),
    });
  });

  it.each(["missing", "tampered", "wrong-owner"])(
    "does not reconstruct a %s native backup",
    async (kind) => {
      let wrongBackup: string | undefined;
      if (kind === "wrong-owner") {
        await db.update(user).set({ role: "admin" }).where(eq(user.id, otherId));
        expect((await other.start(targetId)).status).toBe(200);
        wrongBackup = other.cookies.get("better-auth.admin_session");
        expect(wrongBackup).toBeTruthy();
      }
      expect((await admin.start(targetId)).status).toBe(200);
      const count = logs.length;
      if (kind === "missing") admin.cookies.delete("better-auth.admin_session");
      else
        admin.cookies.set(
          "better-auth.admin_session",
          kind === "tampered" ? "invalid-signature" : wrongBackup!,
        );
      expect((await admin.stop()).status).toBe(500);
      expect((await admin.identity()).body.user.id).toBe(targetId);
      expect(logs).toHaveLength(count);
    },
  );

  it.each(["expired", "revoked"])(
    "requires login for an %s impersonation session",
    async (kind) => {
      expect((await admin.start(targetId)).status).toBe(200);
      const active = (await admin.identity()).body;
      if (kind === "expired")
        await db
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.id, active.session.id));
      else await db.delete(session).where(eq(session.id, active.session.id));
      expect((await admin.stop()).status).toBe(401);
      expect((await admin.identity()).body).toBeNull();
      expect(logs).toHaveLength(1);
    },
  );

  it("cannot restore a revoked administrator session", async () => {
    const original = (await admin.identity()).body;
    expect((await admin.start(targetId)).status).toBe(200);
    await db.delete(session).where(eq(session.id, original.session.id));
    expect((await admin.stop()).status).toBe(500);
    expect((await admin.identity()).body.user.id).toBe(targetId);
    expect(logs).toHaveLength(1);
  });

  it("pins native expired-backup behavior: stop writes the backup cookie, the next session read requires login", async () => {
    const original = (await admin.identity()).body;
    expect((await admin.start(targetId)).status).toBe(200);
    await db
      .update(session)
      .set({ expiresAt: new Date(0) })
      .where(eq(session.id, original.session.id));
    expect((await admin.stop()).status).toBe(200);
    expect((await admin.identity()).body).toBeNull();
  });

  it("does not turn a completed transition into an error when operational logging fails", async () => {
    logger.mockRejectedValueOnce(new Error("log sink unavailable"));
    expect((await admin.start(targetId)).status).toBe(200);
    expect((await admin.identity()).body.user.id).toBe(targetId);
  });
});
