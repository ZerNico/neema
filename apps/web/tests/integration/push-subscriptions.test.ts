import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pushKeys, user } from "~/db/schema/index.ts";
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
      db.insert(user).values([
        { id: "a", name: "A", email: "a@t.io" },
        { id: "b", name: "B", email: "b@t.io" },
      ]),
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

it("refuses endpoints the server must not post to, and malformed keys", async () => {
  for (const bad of ["http://8.8.8.8/push", "https://127.0.0.1/push", "https://localhost/push"])
    await expect(
      push((p) => p.subscribe("a", { endpoint: bad, ...keys, label: "x" })),
    ).rejects.toThrow();
  await expect(
    push((p) => p.subscribe("a", { endpoint, p256dh: keys.auth, auth: keys.auth, label: "x" })),
  ).rejects.toMatchObject({ _tag: "PushRejected", reason: "the subscription keys are malformed" });
});

it("moves a browser to whoever subscribed it last, and removes it on request", async () => {
  await push((p) => p.subscribe("a", { endpoint, ...keys, label: "Chrome on macOS" }));
  expect(await push((p) => p.list("a"))).toEqual([
    expect.objectContaining({ label: "Chrome on macOS", lastDeliveredAt: null }),
  ]);
  await push((p) => p.subscribe("b", { endpoint, ...keys, label: "Chrome on macOS" }));
  expect(await push((p) => p.list("a"))).toEqual([]);
  const [device] = await push((p) => p.list("b"));
  // Another person's id removes nothing.
  await push((p) => p.remove("a", device!.id));
  expect(await push((p) => p.list("b"))).toHaveLength(1);
  await push((p) => p.unsubscribe("b", endpoint));
  expect(await push((p) => p.list("b"))).toEqual([]);
});
