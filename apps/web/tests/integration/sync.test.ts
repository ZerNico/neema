import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Cause, Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { approvalEvents } from "~/modules/auth/server/approval-events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let runtime: ManagedRuntime.ManagedRuntime<SyncBus | Db, unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  pool = new Pool({ connectionString: url });
  runtime = ManagedRuntime.make(
    Layer.mergeAll(SyncBus.layer, Db.layer).pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
    ),
  );
  await runtime.runPromise(SyncBus);
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await pool?.end();
  await container?.stop();
});

it("delivers database wakeups only after commit and discards rolled-back notifications", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const db = yield* Db;
      const pull = yield* Stream.toPull(bus.subscribe("reader").pipe(Stream.rechunk(1)));
      expect(yield* pull).toEqual([{ type: "sync.ready" }]);
      const written = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const writer = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* notifyOnCommit(tx, {
              scope: "user",
              userId: "reader",
              event: { type: "memory.changed" },
            });
            yield* Deferred.succeed(written, undefined);
            yield* Deferred.await(commit);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(written);
      // A separate committed notification is a delivery barrier while the writer is open.
      yield* bus.publish("reader", { type: "resources.changed" });
      expect(yield* pull).toEqual([{ type: "resources.changed" }]);
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(writer);
      expect(yield* pull).toEqual([{ type: "memory.changed" }]);
      yield* db
        .transaction((tx) =>
          notifyOnCommit(tx, {
            scope: "user",
            userId: "reader",
            event: { type: "memory.changed" },
          }).pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.result);
      yield* bus.publish("reader", { type: "resources.changed" });
      expect(yield* pull).toEqual([{ type: "resources.changed" }]);
    }).pipe(Effect.scoped),
  );
});

it("keeps internal signals and other accounts out of browser and approval feeds", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const db = yield* Db;
      const browser = yield* Stream.toPull(bus.subscribe("reader").pipe(Stream.rechunk(1)));
      expect(yield* browser).toEqual([{ type: "sync.ready" }]);
      const privateFeed = yield* Stream.toPull(
        bus.subscribe("reader", true).pipe(Stream.rechunk(1)),
      );
      expect(yield* privateFeed).toEqual([{ type: "sync.ready" }]);
      const approval = yield* Stream.toPull(approvalEvents(bus, "reader").pipe(Stream.rechunk(1)));
      const internal = yield* Stream.toPull(bus.signals.pipe(Stream.rechunk(1)));
      expect(yield* approval).toEqual([null]);
      expect(yield* internal).toEqual([{ type: "ready" }]);
      yield* db.transaction((tx) =>
        notifyOnCommit(tx, {
          scope: "internal",
          event: { type: "knowledge.work", stage: "extraction" },
        }),
      );
      yield* bus.publish("other", { type: "account.approval.changed" });
      yield* bus.publishGlobal({ type: "resources.changed" });
      yield* bus.publishGlobal({ type: "account.approval.changed" });
      yield* bus.publish("reader", { type: "memory.changed" });
      yield* bus.publish("reader", { type: "account.approval.changed" });
      expect(yield* internal).toEqual([{ type: "knowledge.work", stage: "extraction" }]);
      expect(yield* privateFeed).toEqual([{ type: "memory.changed" }]);
      expect(yield* privateFeed).toEqual([{ type: "account.approval.changed" }]);
      expect(yield* browser).toEqual([{ type: "resources.changed" }]);
      expect(yield* browser).toEqual([{ type: "account.approval.changed" }]);
      expect(yield* browser).toEqual([{ type: "memory.changed" }]);
      expect(yield* browser).toEqual([{ type: "account.approval.changed" }]);
      expect(yield* approval).toEqual([null]);
      // Observe through an allowed barrier, not a timer-based assertion of silence.
      yield* bus.publish("reader", { type: "account.approval.changed" });
      expect(yield* approval).toEqual([null]);
    }).pipe(Effect.scoped),
  );
});

it("announces reconciliation when a slow consumer overflows the bounded local relay", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const slow = yield* Stream.toPull(bus.subscribe("reader").pipe(Stream.rechunk(1)));
      const barrier = yield* Stream.toPull(bus.subscribe("barrier").pipe(Stream.rechunk(1)));
      expect(yield* slow).toEqual([{ type: "sync.ready" }]);
      expect(yield* barrier).toEqual([{ type: "sync.ready" }]);
      yield* Effect.promise(() =>
        pool.query(`
      select pg_notify('chat_sync', json_build_object('scope', 'user', 'userId', 'reader',
        'event', json_build_object('type', 'conversation.updated', 'conversationId', i::text))::text)
      from generate_series(1, 5000) i
    `),
      );
      yield* bus.publish("barrier", { type: "memory.changed" });
      // The barrier can overflow too; consume through its final domain event.
      let seen = yield* barrier;
      while (seen[0].type === "sync.ready") seen = yield* barrier;
      expect(seen).toEqual([{ type: "memory.changed" }]);
      expect(yield* slow).toEqual([{ type: "sync.ready" }]);
    }).pipe(Effect.scoped),
  );
});

it("reconciles after a real LISTEN connection loss and resumes delivery", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      const browser = yield* Stream.toPull(bus.subscribe("reader").pipe(Stream.rechunk(1)));
      expect(yield* browser).toEqual([{ type: "sync.ready" }]);
      const internal = yield* Stream.toPull(bus.signals.pipe(Stream.rechunk(1)));
      expect(yield* internal).toEqual([{ type: "ready" }]);
      const killed = yield* Effect.promise(() =>
        pool.query<{ terminated: boolean }>(
          "select pg_terminate_backend(pid) as terminated from pg_stat_activity where application_name = 'chat-notifications'",
        ),
      );
      expect(killed.rows).toEqual([{ terminated: true }]);
      expect(yield* browser).toEqual([{ type: "sync.ready" }]);
      expect(yield* internal).toEqual([{ type: "ready" }]);
      yield* bus.publish("reader", { type: "memory.changed" });
      expect(yield* browser).toEqual([{ type: "memory.changed" }]);
    }).pipe(Effect.scoped),
  );
});

it("ends open feeds when the bus is disposed, so a tab reconnects to its replacement", async () => {
  // A second runtime stands in for the one a dev hot swap throws away.
  const replaced = ManagedRuntime.make(
    SyncBus.layer.pipe(
      Layer.provide(
        PgClient.layer({ url: Redacted.make(container.getConnectionUri()), maxConnections: 2 }),
      ),
    ),
  );
  const feed = await replaced.runPromise(Effect.map(SyncBus, (bus) => bus.subscribe("reader")));
  const drained = runtime.runPromise(Stream.runCollect(feed).pipe(Effect.exit));
  await replaced.dispose();
  // Before the fix the feed never ended: this await hung until the test timed out.
  const exit = await drained;
  expect(exit._tag === "Success" || Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});
