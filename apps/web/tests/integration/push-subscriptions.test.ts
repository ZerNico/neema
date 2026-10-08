import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pushKeys, pushSubscriptions, session, user } from "~/db/schema/index.ts";
import { PushService } from "~/modules/notifications/server/push.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<PushService | Db, unknown>;
const push = <A, E>(use: (push: PushService["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(PushService, use));

// A browser's keys as the Push API reports them: a P-256 point and 16 bytes.
const keys = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
// A public IP literal passes the check without DNS. Nothing here sends to it.
const endpoint = "https://8.8.8.8/push/abc";

beforeAll(async () => {
  database = await createTestDatabase();
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
  );
  const cipher = KeyCipher.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }),
      ),
    ),
  );
  runtime = ManagedRuntime.make(
    PushService.layer.pipe(Layer.provideMerge(cipher), Layer.provideMerge(infra)),
  );
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      Effect.gen(function* () {
        yield* db.insert(user).values([
          { id: "a", name: "A", email: "a@t.io" },
          { id: "b", name: "B", email: "b@t.io" },
        ]);
        const expiresAt = new Date(Date.now() + 86_400_000);
        yield* db.insert(session).values([
          { id: "sa", userId: "a", token: "ta", expiresAt },
          { id: "sb", userId: "b", token: "tb", expiresAt },
        ]);
      }),
    ),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

it("makes one server key and keeps its private half encrypted", async () => {
  const [first, second] = await Promise.all([push((p) => p.publicKey), push((p) => p.publicKey)]);
  expect(first).toBe(second);
  const rows = await runtime.runPromise(Effect.flatMap(Db, (db) => db.select().from(pushKeys)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.privateKeyCiphertext.split(".")).toHaveLength(3);
});

const a = { userId: "a", sessionId: "sa" };
const b = { userId: "b", sessionId: "sb" };
const owners = () =>
  runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint)),
    ),
  );

it("refuses endpoints the server must not post to, and malformed keys", async () => {
  for (const bad of ["http://8.8.8.8/push", "https://127.0.0.1/push", "https://localhost/push"])
    await expect(push((p) => p.subscribe(a, { endpoint: bad, ...keys }))).rejects.toThrow();
  await expect(
    push((p) => p.subscribe(a, { endpoint, p256dh: keys.auth, auth: keys.auth })),
  ).rejects.toMatchObject({ _tag: "PushRejected", reason: "the subscription keys are malformed" });
});

it("moves a browser to whoever signed in last, and stops it when that sign-in ends", async () => {
  await push((p) => p.subscribe(a, { endpoint, ...keys }));
  expect(await owners()).toEqual([{ userId: "a" }]);
  await push((p) => p.subscribe(b, { endpoint, ...keys }));
  expect(await owners()).toEqual([{ userId: "b" }]);
  // Signing out, or revoking the device, deletes the session.
  await runtime.runPromise(
    Effect.flatMap(Db, (db) => db.delete(session).where(eq(session.id, "sb"))),
  );
  expect(await owners()).toEqual([]);
});
