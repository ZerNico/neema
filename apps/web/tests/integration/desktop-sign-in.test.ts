import { PgClient } from "@effect/sql-pg";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Schedule, Stream } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { relations } from "~/db/relations.ts";
import { session, signupBootstrap, user, verification } from "~/db/schema/index.ts";
import {
  challengeOf,
  createVerifier,
  DESKTOP_SESSION_SECONDS,
  DESKTOP_TICKET_MINUTES,
  formatTicket,
} from "~/modules/auth/desktop-ticket.ts";
import { createAppAuth } from "~/modules/auth/server/config.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

const origin = "http://localhost:9877";
const DESKTOP_UA = "Mozilla/5.0 Electron/38.0.0 ChatDesktop/0.1.0";
const BROWSER_UA = "Mozilla/5.0 Safari/605.1.15";
const DAY = 24 * 60 * 60 * 1000;

let database: TestDatabase;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof relations>>;
let auth: ReturnType<typeof createAppAuth>;
let runtime: ManagedRuntime.ManagedRuntime<SyncBus, never>;
const pending = new Set<string>();

/** Wait for subscription readiness before the caller acts. */
const listenFor = (userId: string) =>
  Effect.gen(function* () {
    const bus = yield* SyncBus;
    const pull = yield* Stream.toPull(bus.subscribe(userId).pipe(Stream.rechunk(1)));
    expect(yield* pull).toEqual([{ type: "sync.ready" }]);
    return { next: () => Effect.map(pull, (chunk) => chunk[0]) };
  });

/** One event for `userId`, gathered by `subscribe` before `act` runs. */
const eventDuring = async (userId: string, act: () => Promise<void>) =>
  runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* listenFor(userId);
        yield* Effect.promise(act);
        // A bound on the NOTIFY round trip, generous because the whole
        // integration project shares one machine with several containers.
        return yield* listener.next().pipe(Effect.timeout("30 seconds"));
      }),
    ),
  );

/** One cookie jar per user agent, the way a browser and the shell each keep their own. */
class Client {
  cookies = new Map<string, string>();
  lastSetCookies: string[] = [];
  constructor(
    readonly userAgent: string,
    readonly ip = "203.0.113.1",
  ) {}
  async request(path: string, body?: object) {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          "content-type": "application/json",
          "user-agent": this.userAgent,
          "x-forwarded-for": this.ip,
          cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    this.lastSetCookies = response.headers.getSetCookie();
    for (const cookie of this.lastSetCookies) {
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
  session() {
    return this.request("/get-session");
  }
  ticket(challenge?: string) {
    return this.request("/desktop/ticket", challenge ? { challenge } : {});
  }
  redeem(ticket: string, verifier?: string, boundOnly?: boolean) {
    return this.request("/desktop/session", {
      ticket,
      ...(verifier ? { verifier } : {}),
      ...(boundOnly ? { boundOnly } : {}),
    });
  }
  refresh() {
    return this.request("/desktop/session/refresh", {});
  }
  devices() {
    return this.request("/desktop/devices");
  }
  revokeDevice(id: string) {
    return this.request("/desktop/devices/revoke", { id });
  }
  sessionCookieMaxAge() {
    const header = this.lastSetCookies.find((c) => c.startsWith("better-auth.session_token="));
    const match = header?.match(/max-age=(\d+)/i);
    return match ? Number(match[1]) : null;
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  pool = new Pool({ connectionString: url });
  db = drizzle({ client: pool, relations });
  runtime = ManagedRuntime.make(
    SyncBus.layer.pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 3 })),
      Layer.orDie,
    ),
  );
  // The relay's LISTEN is acquired after the layer resolves; a probe that has
  // to make the round trip is the only proof it is up.
  await runtime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* listenFor("probe");
        yield* Effect.flatMap(SyncBus, (bus) => bus.publish("probe", { type: "memory.changed" }));
        yield* listener.next().pipe(Effect.timeout("200 millis"));
      }),
    ).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 })),
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
      record: async () => {},
      approved: async (userId) => !pending.has(userId),
    },
    onDesktopRedeemed: (userId, ticketId) =>
      runtime.runPromise(
        Effect.flatMap(SyncBus, (bus) =>
          bus.publish(userId, { type: "desktop.session.created", ticketId }),
        ),
      ),
    rateLimit: true,
  });
}, 120_000);
afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await database?.drop();
});

let browser: Client, desktop: Client, userId: string;
let ipCounter = 0;
beforeEach(async () => {
  await db.delete(user);
  await db.delete(signupBootstrap);
  await db.delete(verification);
  pending.clear();
  // A fresh address per test keeps the in-memory limiter from carrying counts
  // across tests; the limiter is itself under test only where it says so.
  ipCounter += 1;
  const ip = `203.0.113.${ipCounter}`;
  browser = new Client(BROWSER_UA, ip);
  desktop = new Client(DESKTOP_UA, ip);
  userId = await browser.signup("nico");
});

const withinDays = (date: string, days: number) => {
  const delta = new Date(date).getTime() - Date.now();
  expect(delta).toBeGreaterThan(days * DAY - 60_000);
  expect(delta).toBeLessThanOrEqual(days * DAY + 60_000);
};

describe("minting a ticket", () => {
  it("needs a session", async () => {
    expect((await desktop.ticket()).status).toBe(401);
  });

  it("returns a formatted-friendly code with a three minute expiry and stores only a hash", async () => {
    const { status, body } = await browser.ticket();
    expect(status).toBe(200);
    expect(body.ticket).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{20}$/);
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan((DESKTOP_TICKET_MINUTES - 0.5) * 60_000);
    expect(ttl).toBeLessThanOrEqual(DESKTOP_TICKET_MINUTES * 60_000);
    const rows = await db.select().from(verification);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toMatch(/^desktop-ticket:[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(body.ticket);
    expect(body.ticketId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]!.value).toContain(body.ticketId);
  });

  it("refuses an account still waiting for approval", async () => {
    pending.add(userId);
    expect((await browser.ticket()).status).toBe(403);
  });

  it("refuses an impersonated session", async () => {
    const target = new Client(BROWSER_UA, browser.ip);
    const targetId = await target.signup("target");
    expect((await browser.request("/admin/impersonate-user", { userId: targetId })).status).toBe(
      200,
    );
    expect((await browser.ticket()).status).toBe(403);
  });
});

describe("redeeming a ticket", () => {
  it("gives the desktop a separate 90-day session for the same user", async () => {
    const browserSession = (await browser.session()).body;
    const { body } = await browser.ticket();
    const redeemed = await desktop.redeem(formatTicket(body.ticket).toLowerCase());
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toEqual({ ok: true });
    expect(desktop.sessionCookieMaxAge()).toBe(DESKTOP_SESSION_SECONDS);

    const current = (await desktop.session()).body;
    expect(current.user.id).toBe(userId);
    expect(current.session.token).not.toBe(browserSession.session.token);
    expect(current.session.userAgent).toBe(DESKTOP_UA);
    withinDays(current.session.expiresAt, 90);
    withinDays(browserSession.session.expiresAt, 7);
    expect(await db.select().from(verification)).toEqual([]);
  });

  it("is single use and tells wrong, used and malformed codes apart from nothing", async () => {
    const { body } = await browser.ticket();
    expect((await desktop.redeem(body.ticket)).status).toBe(200);
    const again = await new Client(DESKTOP_UA, browser.ip).redeem(body.ticket);
    expect(again.status).toBe(400);
    expect(again.body.message).toBe("That code is not valid.");
    const wrong = await new Client(DESKTOP_UA, browser.ip).redeem("ABCDEFGHJKMNPQRSTVWX");
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe("That code is not valid.");
    const short = await new Client(DESKTOP_UA, browser.ip).redeem("abc");
    expect(short.status).toBe(400);
    expect(short.body.message).toBe("That code is not valid.");
  });

  it("refuses an expired ticket", async () => {
    const { body } = await browser.ticket();
    // Expiry is judged by the store, so age the row rather than the clock.
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) });
    const late = await desktop.redeem(body.ticket);
    expect(late.status).toBe(400);
    expect(late.body.message).toBe("That code is not valid.");
    expect(await db.select().from(verification)).toEqual([]);
  });

  it("binds a challenge ticket to the verifier that produced it", async () => {
    const verifier = createVerifier();
    const first = (await browser.ticket(await challengeOf(verifier))).body;
    expect((await desktop.redeem(first.ticket)).status).toBe(400);
    const second = (await browser.ticket(await challengeOf(verifier))).body;
    expect((await desktop.redeem(second.ticket, createVerifier())).status).toBe(400);
    const third = (await browser.ticket(await challengeOf(verifier))).body;
    expect((await desktop.redeem(third.ticket, verifier)).status).toBe(200);
    expect((await desktop.session()).body.user.id).toBe(userId);
  });

  it("announces the redemption to the minting user's tabs by ticket id, never by code", async () => {
    const { body } = await browser.ticket();
    const event = await eventDuring(userId, async () => {
      expect((await desktop.redeem(body.ticket)).status).toBe(200);
    });
    expect(event).toEqual({ type: "desktop.session.created", ticketId: body.ticketId });
    expect(JSON.stringify(event)).not.toContain(body.ticket);
    // Another user's feed hears nothing about it.
    const other = new Client(BROWSER_UA, browser.ip);
    const otherId = await other.signup("other");
    const next = (await browser.ticket()).body;
    const otherEvents: SyncEvent[] = [];
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* listenFor(otherId);
          yield* Effect.promise(async () => {
            expect((await new Client(DESKTOP_UA, browser.ip).redeem(next.ticket)).status).toBe(200);
          });
          const heard = yield* listener.next().pipe(Effect.timeout("300 millis"), Effect.option);
          if (heard._tag === "Some") otherEvents.push(heard.value);
        }),
      ),
    );
    expect(otherEvents).toEqual([]);
  });

  it("leaves a code no shell asked for unused when a deep link may only redeem bound ones", async () => {
    const pasteOnly = (await browser.ticket()).body;
    const refused = await desktop.redeem(pasteOnly.ticket, createVerifier(), true);
    expect(refused.status).toBe(409);
    // Still there for the person to confirm by hand.
    expect((await desktop.redeem(pasteOnly.ticket)).status).toBe(200);

    const verifier = createVerifier();
    const bound = (await browser.ticket(await challengeOf(verifier))).body;
    expect(
      (await new Client(DESKTOP_UA, browser.ip).redeem(bound.ticket, verifier, true)).status,
    ).toBe(200);
  });

  it("lets a paste-only ticket ignore any verifier", async () => {
    const { body } = await browser.ticket();
    expect((await desktop.redeem(body.ticket, createVerifier())).status).toBe(200);
  });

  it("keeps the two sessions independent when one is revoked", async () => {
    const { body } = await browser.ticket();
    expect((await desktop.redeem(body.ticket)).status).toBe(200);
    const desktopToken = (await desktop.session()).body.session.token as string;
    expect((await browser.request("/revoke-session", { token: desktopToken })).status).toBe(200);
    expect((await desktop.session()).body).toBeNull();
    expect((await browser.session()).body.user.id).toBe(userId);

    const next = (await browser.ticket()).body;
    const shell = new Client(DESKTOP_UA, browser.ip);
    expect((await shell.redeem(next.ticket)).status).toBe(200);
    expect((await browser.request("/sign-out", {})).status).toBe(200);
    expect((await browser.session()).body).toBeNull();
    expect((await shell.session()).body.user.id).toBe(userId);
  });
});

describe("refreshing a desktop session", () => {
  it("extends to a fresh 90 days and re-sets the cookie", async () => {
    const { body } = await browser.ticket();
    expect((await desktop.redeem(body.ticket)).status).toBe(200);
    const id = (await desktop.session()).body.session.id as string;
    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() + 10 * DAY) })
      .where(eq(session.id, id));
    const refreshed = await desktop.refresh();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.ok).toBe(true);
    withinDays(refreshed.body.expiresAt, 90);
    expect(desktop.sessionCookieMaxAge()).toBe(DESKTOP_SESSION_SECONDS);
    const [row] = await db.select().from(session).where(eq(session.id, id));
    withinDays(row!.expiresAt.toISOString(), 90);
  });

  it("refuses a browser and an anonymous caller", async () => {
    expect((await browser.refresh()).status).toBe(403);
    const before = (await browser.session()).body.session.expiresAt;
    withinDays(before, 7);
    expect((await new Client(DESKTOP_UA, browser.ip).refresh()).status).toBe(401);
  });

  it("refuses a browser session even when the request claims to be the shell", async () => {
    const spoof = new Client(DESKTOP_UA, browser.ip);
    spoof.cookies = new Map(browser.cookies);
    expect((await spoof.refresh()).status).toBe(403);
    const before = (await browser.session()).body.session.expiresAt;
    withinDays(before, 7);
  });
});

describe("listing and revoking devices", () => {
  const pair = async () => {
    const { body } = await browser.ticket();
    expect((await desktop.redeem(body.ticket)).status).toBe(200);
    return {
      browserId: (await browser.session()).body.session.id as string,
      desktopId: (await desktop.session()).body.session.id as string,
    };
  };

  it("lists both sessions with a current flag and no token", async () => {
    const { browserId, desktopId } = await pair();
    const { status, body } = await browser.devices();
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.map((d: { id: string; current: boolean }) => [d.id, d.current]).toSorted()).toEqual(
      [
        [browserId, true],
        [desktopId, false],
      ].toSorted(),
    );
    for (const device of body) {
      expect(device).not.toHaveProperty("token");
      expect(Object.keys(device).toSorted()).toEqual(
        [
          "createdAt",
          "current",
          "expiresAt",
          "id",
          "ipAddress",
          "updatedAt",
          "userAgent",
        ].toSorted(),
      );
    }
    expect(body.find((d: { id: string }) => d.id === desktopId).userAgent).toBe(DESKTOP_UA);
    expect(
      (await desktop.devices()).body.find((d: { id: string }) => d.id === desktopId).current,
    ).toBe(true);
  });

  it("revokes the desktop by id from the browser and refuses the browser's own session", async () => {
    const { browserId, desktopId } = await pair();
    const own = await browser.revokeDevice(browserId);
    expect(own.status).toBe(400);
    expect(own.body.message).toBe("Use sign out for this device.");
    expect((await browser.session()).body.user.id).toBe(userId);

    const revoked = await browser.revokeDevice(desktopId);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ ok: true });
    expect((await desktop.session()).body).toBeNull();
    expect((await browser.devices()).body).toHaveLength(1);
  });

  it("treats an unknown id and another user's id as a no-op", async () => {
    const other = new Client(BROWSER_UA, browser.ip);
    await other.signup("other");
    const otherId = (await other.session()).body.session.id as string;
    expect((await browser.revokeDevice("no-such-session")).body).toEqual({ ok: true });
    expect((await browser.revokeDevice(otherId)).body).toEqual({ ok: true });
    expect((await other.session()).body.session.id).toBe(otherId);
  });

  it("needs a session and refuses an impersonated caller", async () => {
    expect((await desktop.devices()).status).toBe(401);
    expect((await desktop.revokeDevice("x")).status).toBe(401);
    const { desktopId } = await pair();
    const target = new Client(BROWSER_UA, browser.ip);
    const targetId = await target.signup("target");
    expect((await browser.request("/admin/impersonate-user", { userId: targetId })).status).toBe(
      200,
    );
    expect((await browser.devices()).status).toBe(200);
    expect((await browser.revokeDevice(desktopId)).status).toBe(403);
    expect((await desktop.session()).body.user.id).toBe(userId);
  });

  it("works from a two-day-old session, where freshness would refuse", async () => {
    const { browserId, desktopId } = await pair();
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(session.id, browserId));
    const stale = await browser.request("/list-sessions");
    expect(stale.status).toBe(403);
    expect((await browser.devices()).status).toBe(200);
    expect((await browser.revokeDevice(desktopId)).status).toBe(200);
    expect((await desktop.session()).body).toBeNull();
  });
});

describe("rate limiting", () => {
  // This ip is shared across the burst on purpose; the limiter keys on it.
  afterEach(() => {
    ipCounter += 1;
  });

  it("answers the sixth redemption attempt in a minute with 429", async () => {
    const { body } = await browser.ticket();
    for (let i = 0; i < 5; i++) {
      expect((await new Client(DESKTOP_UA, browser.ip).redeem("ABCDEFGHJKMNPQRSTVWX")).status).toBe(
        400,
      );
    }
    const blocked = await new Client(DESKTOP_UA, browser.ip).redeem(body.ticket);
    expect(blocked.status).toBe(429);
    // The valid ticket survived the refused attempt, so the limiter did not consume it.
    expect(await db.select().from(verification)).toHaveLength(1);
  });
});
