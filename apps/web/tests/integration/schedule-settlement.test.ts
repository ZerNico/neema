import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { conversations, messages, scheduleRuns, schedules, user } from "~/db/schema/index.ts";
import type { AppNotification } from "~/modules/notifications/schema.ts";
import { NotificationService } from "~/modules/notifications/server/service.ts";
import { ScheduleSettlement } from "~/modules/schedules/server/settle.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<ScheduleSettlement | Db, unknown>;
const delivered: AppNotification[] = [];
const settle = () => runtime.runPromise(Effect.flatMap(ScheduleSettlement, (s) => s.settle));
const db = <A>(use: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(Db, use));

beforeAll(async () => {
  database = await createTestDatabase();
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const notifications = Layer.succeed(NotificationService, {
    deliver: (_userId, notification) => Effect.sync(() => void delivered.push(notification)),
  });
  runtime = ManagedRuntime.make(
    ScheduleSettlement.layer.pipe(
      Layer.provideMerge(notifications),
      Layer.provideMerge(bus),
      Layer.provideMerge(infra),
    ),
  );
  await db((d) => d.insert(user).values({ id: "owner", name: "O", email: "o@t.io" }));
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

beforeEach(() => {
  delivered.length = 0;
});

/** A fire whose answer is still streaming, bound the way createTurn binds it. */
async function startedRun(notify: "off" | "always" | "conditional" = "always") {
  const scheduleId = uuidv7();
  const conversationId = uuidv7();
  const messageId = uuidv7();
  const generationId = uuidv7();
  const runId = uuidv7();
  await db((d) =>
    Effect.gen(function* () {
      yield* d.insert(schedules).values({
        id: scheduleId,
        userId: "owner",
        name: "Morning digest",
        prompt: "Summarize.",
        scheduleText: "daily",
        cron: "0 7 * * *",
        timezone: "UTC",
        notify,
      });
      yield* d.insert(conversations).values({ id: conversationId, userId: "owner", scheduleId });
      yield* d.insert(messages).values({
        id: messageId,
        conversationId,
        role: "assistant",
        status: "streaming",
        generationId,
      });
      yield* d.insert(scheduleRuns).values({
        id: runId,
        scheduleId,
        status: "started",
        conversationId,
        messageId,
        generationId,
      });
    }),
  );
  const answer = (changes: Partial<typeof messages.$inferInsert>) =>
    db((d) => d.update(messages).set(changes).where(eq(messages.id, messageId)));
  const unread = async () =>
    (
      await db((d) =>
        d
          .select({ unread: conversations.unread })
          .from(conversations)
          .where(eq(conversations.id, conversationId)),
      )
    )[0]!.unread;
  return { scheduleId, conversationId, runId, answer, unread };
}

it("tells the owner once, however many settlers see the answer end", async () => {
  const fire = await startedRun();
  await settle();
  expect(delivered).toEqual([]);

  await fire.answer({ status: "complete", content: "## Rain\n\nAfter **3pm**[^1]." });
  await Promise.all([settle(), settle(), settle()]);
  await settle();
  expect(delivered).toEqual([
    {
      id: fire.runId,
      title: "Morning digest",
      body: "Rain After 3pm.",
      path: `/chat/${fire.conversationId}`,
    },
  ]);
  expect(await fire.unread()).toBe(true);
});

it("says nothing about an answer the person stopped or replaced", async () => {
  const stopped = await startedRun();
  await stopped.answer({ status: "aborted" });
  // A retry gives the same row a new attempt, which is the person's.
  const retried = await startedRun();
  await retried.answer({ generationId: uuidv7() });
  await settle();
  expect(delivered).toEqual([]);
  expect(await stopped.unread()).toBe(false);
  expect(await retried.unread()).toBe(false);
});

it("reports a failure unless the schedule is off, and waits for the model when conditional", async () => {
  const failed = await startedRun();
  await failed.answer({ status: "error" });
  const silent = await startedRun("off");
  await silent.answer({ status: "complete", content: "Done." });
  const conditional = await startedRun("conditional");
  await conditional.answer({ status: "complete", content: "Nothing changed." });
  await settle();
  expect(delivered.map((each) => [each.id, each.body])).toEqual([
    [failed.runId, "Couldn’t finish: the answer stopped with an error"],
  ]);
  // There is still a new answer to read in each chat.
  expect(await silent.unread()).toBe(true);
  expect(await conditional.unread()).toBe(true);
});

it("points a run that never started at its schedule", async () => {
  const scheduleId = (await startedRun()).scheduleId;
  await settle();
  delivered.length = 0;
  const runId = uuidv7();
  await db((d) =>
    d
      .insert(scheduleRuns)
      .values({ id: runId, scheduleId, status: "error", error: "no available model" }),
  );
  await settle();
  expect(delivered).toEqual([
    {
      id: runId,
      title: "Morning digest",
      body: "Couldn’t finish: no available model",
      path: `/schedules/${scheduleId}`,
    },
  ]);
});
