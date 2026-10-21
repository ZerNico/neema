import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sidebarPins, user } from "~/db/schema/index.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SidebarPinsService } from "~/modules/navigation/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<SidebarPinsService | Db, unknown>;
const published: Array<{ userId: string; event: SyncEvent }> = [];
const run = <A, E>(effect: Effect.Effect<A, E, SidebarPinsService | Db>) =>
  runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: (userId: string, event: SyncEvent) =>
      Effect.sync(() => void published.push({ userId, event })),
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  runtime = ManagedRuntime.make(
    SidebarPinsService.layer.pipe(Layer.provideMerge(bus), Layer.provideMerge(infra)),
  );
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(user).values([
        { id: "pins-a", name: "A", email: "pins-a@t.io" },
        { id: "pins-b", name: "B", email: "pins-b@t.io" },
      ]),
    ),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const get = (userId: string) =>
  run(Effect.flatMap(SidebarPinsService, (service) => service.get(userId)));

it("gives the defaults until a person changes them, and only to that person afterwards", async () => {
  expect(await get("pins-a")).toEqual({ pinned: ["projects", "agents", "knowledge", "schedules"] });

  await run(
    Effect.flatMap(SidebarPinsService, (service) => service.set("pins-a", ["skills", "projects"])),
  );
  expect(await get("pins-a")).toEqual({ pinned: ["projects", "skills"] });
  expect(await get("pins-b")).toEqual({ pinned: ["projects", "agents", "knowledge", "schedules"] });
  expect(published).toEqual([{ userId: "pins-a", event: { type: "sidebar.changed" } }]);

  // Unpinning everything is a choice, not a return to the defaults.
  await run(Effect.flatMap(SidebarPinsService, (service) => service.set("pins-a", [])));
  expect(await get("pins-a")).toEqual({ pinned: [] });
});

it("drops a page a later version no longer knows when reading", async () => {
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(sidebarPins).values({ userId: "pins-b", pinned: ["retired", "chats", "chats"] }),
    ),
  );
  expect(await get("pins-b")).toEqual({ pinned: ["chats"] });
});
