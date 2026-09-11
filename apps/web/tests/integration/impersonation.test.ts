import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { relations } from "~/db/relations.ts";
import { session, user } from "~/db/schema/index.ts";
import { createAppAuth, type ImpersonationEvent } from "~/modules/auth/server/config.ts";
import { projectSessionIdentity } from "~/modules/auth/identity.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

const origin = "http://localhost:9876";
let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let auth: ReturnType<typeof createAppAuth>;
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
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  pool = new Pool({ connectionString: url });
  db = drizzle({ client: pool, relations });
  auth = createAppAuth({
    db,
    baseURL: origin,
    secret: "isolated-auth-test-secret-at-least-32-characters",
    purgeUserFiles: async () => {},
    log: logger,
  });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});
beforeEach(async () => {
  await db.delete(user);
  logs.length = 0;
  logger.mockClear();
  admin = new Browser();
  target = new Browser();
  other = new Browser();
  adminId = await admin.signup("admin");
  targetId = await target.signup("target");
  otherId = await other.signup("other");
});

describe("native impersonation through the production handler configuration", () => {
  it("uses first-signup admin, one-hour temporary sessions, native restoration and credential-free logs/projection", async () => {
    const original = (await admin.identity()).body;
    expect(original.user.role).toBe("admin");
    expect((await target.identity()).body.user.role).toBe("user");
    const started = await admin.start(targetId);
    expect(started.status).toBe(200);
    const active = (await admin.identity()).body;
    expect(projectSessionIdentity(active)).toEqual({ userId: targetId, impersonatedBy: adminId });
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
    expect(Object.keys(projectSessionIdentity(active)!)).toEqual(["userId", "impersonatedBy"]);
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
