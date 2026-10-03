import { PgClient } from "@effect/sql-pg";
import { eq, inArray, sql } from "drizzle-orm";
import { Deferred, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conversations,
  groupMembers,
  groups,
  messages,
  models,
  providers,
  scheduleRuns,
  schedules,
  user,
} from "~/db/schema/index.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo, PLAIN_GENERATION } from "~/modules/chat/server/repo.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleFire } from "~/modules/schedules/server/fire.ts";
import { ScheduleRepo, type ScheduleRow } from "~/modules/schedules/server/repo.ts";
import { ScheduleService } from "~/modules/schedules/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { checkScheduleResources } from "~/modules/schedules/server/validate.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let databaseUrl: string;
let runtime: ManagedRuntime.ManagedRuntime<ScheduleRepo | Db, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, ScheduleRepo | Db>) =>
  runtime.runPromise(effect as never) as Promise<A>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  databaseUrl = url;
  runtime = ManagedRuntime.make(
    ScheduleRepo.layer.pipe(
      Layer.provideMerge(Db.layer),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const makeUser = Effect.fn("test.makeUser")(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.insert(user).values({ id: userId, name: "Owner", email: `${userId}@t.io` });
  return userId;
});

const insert = Effect.fn("test.insertSchedule")(function* (
  userId: string,
  changes: Partial<ScheduleRow> = {},
) {
  const repo = yield* ScheduleRepo;
  return yield* repo.insert({
    userId,
    name: "Digest",
    prompt: "Summarize.",
    scheduleText: "every weekday at 7am",
    cron: "0 7 * * 1-5",
    timezone: "UTC",
    endAt: null,
    modelId: null,
    agentId: null,
    searchEnabled: false,
    researchEnabled: false,
    chatMode: "new",
    chatId: null,
    collectionIds: [],
    skillIds: [],
    nextFireAt: null,
    ...changes,
  });
});

// The claim is the whole scheduler: due-ness by DB clock, SKIP LOCKED, and
// rescheduling from now, so downtime costs one catch-up fire.
const chat = (userId: string, scheduleId: string | null = null) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const id = uuidv7();
    yield* db.insert(conversations).values({ id, userId, scheduleId });
    return id;
  });

describe("schedule claims", () => {
  it("claims a due schedule exactly once and reschedules from now", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const row = yield* insert(userId, { nextFireAt: new Date(Date.now() - 60_000) });
        const nextFor = () => new Date(Date.now() + 60_000);
        const first = yield* repo.claimDue(25, nextFor);
        const second = yield* repo.claimDue(25, nextFor);
        const after = yield* repo.get(userId, row.id);
        return { claimed: first.map((r) => r.id), second, after };
      }),
    );
    expect(result.claimed).toHaveLength(1);
    expect(result.second).toEqual([]);
    expect(result.after!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect(result.after!.lastFiredAt).not.toBeNull();
  });

  it("fires once after hours of downtime instead of replaying the backlog", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        // An hourly cadence six hours behind: six missed instants, one claim.
        const row = yield* insert(userId, {
          cron: "0 * * * *",
          nextFireAt: new Date(Date.now() - 6 * 3_600_000),
        });
        const nextFor = () => new Date(Date.now() + 3_600_000);
        const claimed = yield* repo.claimDue(25, nextFor);
        return { claimed: claimed.filter((r) => r.id === row.id) };
      }),
    );
    expect(result.claimed).toHaveLength(1);
  });

  it("skips paused schedules and ones whose next fire is still ahead", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        yield* insert(userId, { nextFireAt: new Date(Date.now() - 1000), paused: true });
        yield* insert(userId, { nextFireAt: new Date(Date.now() + 3_600_000) });
        return yield* repo.claimDue(25, () => null);
      }),
    );
    expect(result).toEqual([]);
  });

  it("terminates a one-shot whose next fire after now is past endAt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const row = yield* insert(userId, { nextFireAt: new Date(Date.now() - 1000) });
        // The service passes the cron-derived next fire, already null past endAt.
        const claimed = yield* repo.claimDue(25, () => null);
        const after = yield* repo.get(userId, row.id);
        return { claimed: claimed.length, nextFireAt: after!.nextFireAt };
      }),
    );
    expect(result.claimed).toBe(1);
    expect(result.nextFireAt).toBeNull();
  });

  it("caps one pass at the batch limit, oldest first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        for (let i = 0; i < 30; i++)
          yield* insert(userId, {
            name: `S${i}`,
            nextFireAt: new Date(Date.now() - (30 - i) * 1000),
          });
        const first = yield* repo.claimDue(25, () => new Date(Date.now() + 60_000));
        const second = yield* repo.claimDue(25, () => new Date(Date.now() + 60_000));
        return { first: first.length, second: second.length };
      }),
    );
    expect(result.first).toBe(25);
    expect(result.second).toBe(5);
  });

  it("two concurrent claims never hand out the same schedule", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        for (let i = 0; i < 10; i++)
          yield* insert(userId, { name: `C${i}`, nextFireAt: new Date(Date.now() - 1000) });
        const nextFor = () => new Date(Date.now() + 60_000);
        const [a, b] = yield* Effect.all([repo.claimDue(25, nextFor), repo.claimDue(25, nextFor)], {
          concurrency: 2,
        });
        return [...a, ...b].map((row) => row.id);
      }),
    );
    expect(result).toHaveLength(10);
    expect(new Set(result).size).toBe(10);
  });
});

describe("durable scheduled attempts", () => {
  it("commits the pending record with the cadence claim and never claims it twice", async () => {
    const result = await run(
      Effect.gen(function* () {
        const owner = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const schedule = yield* insert(owner, { nextFireAt: new Date(Date.now() - 60_000) });
        const [claimed] = yield* repo.claimDue(25, () => null);
        const again = yield* repo.claimDue(25, () => null);
        const runs = yield* db
          .select()
          .from(scheduleRuns)
          .where(eq(scheduleRuns.scheduleId, schedule.id));
        return { claimed, again, runs };
      }),
    );
    expect(result.claimed?.runId).toBe(result.runs[0]?.id);
    expect(result.runs).toMatchObject([{ status: "pending", conversationId: null }]);
    expect(result.again).toEqual([]);
  });

  it("expires only an abandoned pending attempt, not an older live lease", async () => {
    const result = await run(
      Effect.gen(function* () {
        const owner = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const schedule = yield* insert(owner);
        const abandoned = yield* repo.beginRun(schedule.id);
        const waiting = yield* repo.beginRun(schedule.id);
        const renewed = yield* repo.beginRun(schedule.id);
        yield* db
          .update(scheduleRuns)
          .set({ leaseUntil: new Date(Date.now() - 11 * 60_000) })
          .where(eq(scheduleRuns.id, renewed.id));
        yield* repo.renewRun(renewed.id);
        yield* db
          .update(scheduleRuns)
          .set({ leaseUntil: new Date(Date.now() - 11 * 60_000) })
          .where(eq(scheduleRuns.id, abandoned.id));
        yield* db
          .update(scheduleRuns)
          .set({ firedAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(scheduleRuns.id, waiting.id));
        const expired = yield* repo.expirePending();
        const repeated = yield* repo.expirePending();
        const rows = yield* db
          .select()
          .from(scheduleRuns)
          .where(eq(scheduleRuns.scheduleId, schedule.id));
        return { expired, repeated, rows };
      }),
    );
    expect(result.expired).toMatchObject([{ status: "error", conversationId: null }]);
    expect(result.repeated).toEqual([]);
    expect(result.rows.find((row) => row.id === result.expired[0]?.id)?.status).toBe("error");
    expect(result.rows.filter((row) => row.status === "pending")).toHaveLength(2);
  });

  it("binds exactly one turn and rejects a stale or reused attempt inside the turn transaction", async () => {
    const turnRuntime = ManagedRuntime.make(
      ChatRepo.layer.pipe(
        Layer.provideMerge(AttachmentRepo.layer),
        Layer.provideMerge(ScheduleRepo.layer),
        Layer.provideMerge(Db.layer),
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 8 })),
      ),
    );
    try {
      const result = await turnRuntime.runPromise(
        Effect.gen(function* () {
          const owner = yield* makeUser();
          const schedule = yield* insert(owner);
          const repo = yield* ScheduleRepo;
          const chatRepo = yield* ChatRepo;
          const db = yield* Db;
          const providerId = uuidv7();
          const modelId = uuidv7();
          yield* db.insert(providers).values({
            id: providerId,
            name: "Test provider",
            preset: "openrouter",
            baseUrl: "http://x",
            apiKeyCiphertext: "x",
          });
          yield* db.insert(models).values({
            id: modelId,
            providerId,
            modelKey: "scheduled-test",
            displayName: "Test",
            type: "chat",
          });
          const pending = yield* repo.beginRun(schedule.id);
          const create = () =>
            chatRepo.createTurn({
              userId: owner,
              conversation: { kind: "new", id: uuidv7(), mode: "chat" },
              modelId,
              content: schedule.prompt,
              attachmentIds: [],
              scheduleId: schedule.id,
              scheduleRunId: pending.id,
              resolve: () => Effect.succeed(PLAIN_GENERATION),
            });
          const first = yield* create();
          const duplicate = yield* create().pipe(Effect.flip);
          const expired = yield* repo.beginRun(schedule.id);
          yield* db
            .update(scheduleRuns)
            .set({ leaseUntil: new Date(Date.now() - 11 * 60_000) })
            .where(eq(scheduleRuns.id, expired.id));
          yield* repo.expirePending();
          const stale = yield* chatRepo
            .createTurn({
              userId: owner,
              conversation: { kind: "new", id: uuidv7(), mode: "chat" },
              modelId,
              content: schedule.prompt,
              attachmentIds: [],
              scheduleRunId: expired.id,
              resolve: () => Effect.succeed(PLAIN_GENERATION),
            })
            .pipe(Effect.flip);
          const rows = yield* db
            .select()
            .from(scheduleRuns)
            .where(eq(scheduleRuns.scheduleId, schedule.id));
          const turns = yield* db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, first.conversation.id));
          const chats = yield* db
            .select()
            .from(conversations)
            .where(eq(conversations.scheduleId, schedule.id));
          return { first, duplicate, stale, rows, turns, chats };
        }),
      );
      expect(result.duplicate._tag).toBe("InvalidMessage");
      expect(result.stale._tag).toBe("InvalidMessage");
      expect(
        result.rows.find((row) => row.conversationId === result.first.conversation.id)?.status,
      ).toBe("started");
      expect(result.turns).toHaveLength(2);
      expect(result.chats).toHaveLength(1);
    } finally {
      await turnRuntime.dispose();
    }
  });

  it("leaves an archived chat archived when a schedule fires into it, and unarchives it on a send", async () => {
    const turnRuntime = ManagedRuntime.make(
      ChatRepo.layer.pipe(
        Layer.provideMerge(AttachmentRepo.layer),
        Layer.provideMerge(ScheduleRepo.layer),
        Layer.provideMerge(Db.layer),
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 8 })),
      ),
    );
    try {
      const result = await turnRuntime.runPromise(
        Effect.gen(function* () {
          const owner = yield* makeUser();
          const schedule = yield* insert(owner);
          const repo = yield* ScheduleRepo;
          const chatRepo = yield* ChatRepo;
          const db = yield* Db;
          const providerId = uuidv7();
          const modelId = uuidv7();
          yield* db.insert(providers).values({
            id: providerId,
            name: "Test provider",
            preset: "openrouter",
            baseUrl: "http://x",
            apiKeyCiphertext: "x",
          });
          yield* db.insert(models).values({
            id: modelId,
            providerId,
            modelKey: "archive-test",
            displayName: "Test",
            type: "chat",
          });
          const chatId = uuidv7();
          yield* db
            .insert(conversations)
            .values({ id: chatId, userId: owner, title: "Put away", archivedAt: new Date() });
          const archivedAt = () =>
            db
              .select({ archivedAt: conversations.archivedAt })
              .from(conversations)
              .where(eq(conversations.id, chatId))
              .pipe(Effect.map((rows) => rows[0]?.archivedAt ?? null));

          const fire = yield* repo.beginRun(schedule.id);
          yield* chatRepo.createTurn({
            userId: owner,
            conversation: { kind: "existing", id: chatId },
            modelId,
            content: schedule.prompt,
            attachmentIds: [],
            scheduleId: schedule.id,
            scheduleRunId: fire.id,
            resolve: () => Effect.succeed(PLAIN_GENERATION),
          });
          const afterFire = yield* archivedAt();
          yield* db
            .update(messages)
            .set({ status: "complete" })
            .where(eq(messages.conversationId, chatId));
          yield* chatRepo.createTurn({
            userId: owner,
            conversation: { kind: "existing", id: chatId },
            modelId,
            content: "and one more thing",
            attachmentIds: [],
            resolve: () => Effect.succeed(PLAIN_GENERATION),
          });
          const afterSend = yield* archivedAt();
          return { afterFire, afterSend };
        }),
      );
      expect(result.afterFire).not.toBeNull();
      expect(result.afterSend).toBeNull();
    } finally {
      await turnRuntime.dispose();
    }
  });
});

describe("schedule capability revocation", () => {
  it("records a skipped fire without a chat, then fires after a regrant", async () => {
    let published = Effect.runSync(Deferred.make<void>());
    let fireCalls = 0;
    const fakeFire = Layer.effect(
      ScheduleFire,
      Effect.gen(function* () {
        const db = yield* Db;
        return ScheduleFire.of((row, runId) =>
          Effect.gen(function* () {
            fireCalls++;
            const conversationId = uuidv7();
            yield* db
              .insert(conversations)
              .values({ id: conversationId, userId: row.userId, scheduleId: row.id })
              .pipe(Effect.orDie);
            yield* db
              .update(scheduleRuns)
              .set({ status: "started", conversationId })
              .where(eq(scheduleRuns.id, runId))
              .pipe(Effect.orDie);
            return { conversationId };
          }),
        );
      }),
    );
    const fakeBus = Layer.succeed(
      SyncBus,
      SyncBus.of({
        publish: (_userId, event) =>
          event.type === "schedule.run.changed"
            ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
            : Effect.void,
      } as SyncBus["Service"]),
    );
    const serviceRuntime = ManagedRuntime.make(
      ScheduleService.layer.pipe(
        Layer.provideMerge(FeaturePolicy.layer),
        Layer.provideMerge(fakeFire),
        Layer.provideMerge(fakeBus),
        Layer.provideMerge(Layer.succeed(AgentRepo, {} as AgentRepo["Service"])),
        Layer.provideMerge(Layer.succeed(ProviderRepo, {} as ProviderRepo["Service"])),
        Layer.provideMerge(Db.layer),
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 8 })),
      ),
    );
    try {
      // Start the service's tick loop before adding a due schedule.
      await serviceRuntime.runPromise(
        Effect.gen(function* () {
          yield* ScheduleService;
        }),
      );
      const { userId, groupId, scheduleId } = await run(
        Effect.gen(function* () {
          const db = yield* Db;
          const ownerId = yield* makeUser();
          const policyGroupId = uuidv7();
          yield* db.insert(groups).values({
            id: policyGroupId,
            name: `schedule-policy-${policyGroupId}`,
            capabilities: { ...ALL_CAPABILITIES, schedules: false },
          });
          yield* db.insert(groupMembers).values({ groupId: policyGroupId, userId: ownerId });
          const schedule = yield* insert(ownerId, {
            cron: "* * * * *",
            nextFireAt: new Date(Date.now() - 60_000),
          });
          return { userId: ownerId, groupId: policyGroupId, scheduleId: schedule.id };
        }),
      );
      await serviceRuntime.runPromise(
        Effect.gen(function* () {
          const service = yield* ScheduleService;
          yield* service.tick;
          yield* Deferred.await(published);
        }),
      );
      const skipped = await run(
        Effect.gen(function* () {
          const db = yield* Db;
          const [schedule] = yield* db.select().from(schedules).where(eq(schedules.id, scheduleId));
          const runs = yield* db
            .select()
            .from(scheduleRuns)
            .where(eq(scheduleRuns.scheduleId, scheduleId));
          const chats = yield* db
            .select()
            .from(conversations)
            .where(eq(conversations.scheduleId, scheduleId));
          return { schedule, runs, chats };
        }),
      );
      expect(skipped.schedule!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
      expect(skipped.runs).toMatchObject([
        { status: "skipped", conversationId: null, error: "schedule access is not permitted" },
      ]);
      expect(skipped.chats).toEqual([]);
      expect(fireCalls).toBe(0);

      published = Effect.runSync(Deferred.make<void>());
      await run(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db
            .update(groups)
            .set({ capabilities: ALL_CAPABILITIES })
            .where(eq(groups.id, groupId));
          yield* db
            .update(schedules)
            .set({ nextFireAt: new Date(Date.now() - 60_000) })
            .where(eq(schedules.id, scheduleId));
        }),
      );
      await serviceRuntime.runPromise(
        Effect.gen(function* () {
          const service = yield* ScheduleService;
          yield* service.tick;
          yield* Deferred.await(published);
        }),
      );
      const restored = await run(
        Effect.gen(function* () {
          const db = yield* Db;
          const runs = yield* db
            .select()
            .from(scheduleRuns)
            .where(eq(scheduleRuns.scheduleId, scheduleId));
          const chats = yield* db
            .select()
            .from(conversations)
            .where(eq(conversations.scheduleId, scheduleId));
          return { runs, chats };
        }),
      );
      expect(restored.runs).toMatchObject([
        { status: "skipped", conversationId: null },
        { status: "started", conversationId: restored.chats[0]?.id },
      ]);
      expect(restored.chats).toHaveLength(1);
      expect(restored.chats[0]?.userId).toBe(userId);
      expect(fireCalls).toBe(1);
    } finally {
      await serviceRuntime.dispose();
    }
  });
});

describe("manual schedule fires", () => {
  it("keeps old but active manual and claimed fires pending across service recreation", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const settled = Effect.runSync(Deferred.make<void>());
    let started = 0;
    let finished = 0;
    const expectedScheduleIds = new Set<string>();
    const fakeFire = Layer.succeed(
      ScheduleFire,
      ScheduleFire.of(() =>
        Effect.gen(function* () {
          started++;
          if (started === 2) yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return { conversationId: null, error: "pre-turn check failed" };
        }),
      ),
    );
    const fakeBus = Layer.succeed(
      SyncBus,
      SyncBus.of({
        publish: (_userId, event) =>
          event.type === "schedule.run.changed" && expectedScheduleIds.has(event.scheduleId)
            ? Effect.gen(function* () {
                finished++;
                if (finished === 2) yield* Deferred.succeed(settled, undefined);
              })
            : Effect.void,
      } as SyncBus["Service"]),
    );
    const makeRuntime = () =>
      ManagedRuntime.make(
        ScheduleService.layer.pipe(
          Layer.provideMerge(FeaturePolicy.layer),
          Layer.provideMerge(fakeFire),
          Layer.provideMerge(fakeBus),
          Layer.provideMerge(Layer.succeed(AgentRepo, {} as AgentRepo["Service"])),
          Layer.provideMerge(Layer.succeed(ProviderRepo, {} as ProviderRepo["Service"])),
          Layer.provideMerge(Db.layer),
          Layer.provideMerge(
            PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 8 }),
          ),
        ),
      );
    const first = makeRuntime();
    const replacement = makeRuntime();
    try {
      await first.runPromise(ScheduleService);
      const { owner, manual, due } = await run(
        Effect.gen(function* () {
          const owner = yield* makeUser();
          const manual = yield* insert(owner, { nextFireAt: new Date(Date.now() + 3_600_000) });
          const due = yield* insert(owner, { nextFireAt: new Date(Date.now() - 60_000) });
          return { owner, manual, due };
        }),
      );
      expectedScheduleIds.add(manual.id);
      expectedScheduleIds.add(due.id);
      await first.runPromise(
        Effect.flatMap(ScheduleService, (service) =>
          Effect.gen(function* () {
            yield* service.runNow(owner, manual.id);
            yield* service.tick;
            yield* Deferred.await(entered);
          }),
        ),
      );
      await run(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db
            .update(scheduleRuns)
            .set({ firedAt: new Date(Date.now() - 11 * 60_000) })
            .where(inArray(scheduleRuns.scheduleId, [manual.id, due.id]));
        }),
      );
      await replacement.runPromise(Effect.flatMap(ScheduleService, (service) => service.tick));
      const pending = await run(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* db
            .select()
            .from(scheduleRuns)
            .where(inArray(scheduleRuns.scheduleId, [manual.id, due.id]));
        }),
      );
      expect(pending.every((row) => row.status === "pending")).toBe(true);
      expect(pending.map((row) => row.scheduleId).sort()).toEqual([due.id, manual.id].sort());
      expect(started).toBe(2);
      await first.runPromise(Deferred.succeed(release, undefined));
      await first.runPromise(Deferred.await(settled));
      const finishedRuns = await run(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* db
            .select()
            .from(scheduleRuns)
            .where(inArray(scheduleRuns.scheduleId, [manual.id, due.id]));
        }),
      );
      expect(finishedRuns.map((row) => row.status)).toEqual(["error", "error"]);
    } finally {
      await first.runPromise(Deferred.succeed(release, undefined));
      await first.dispose();
      await replacement.dispose();
    }
  });

  it.each(["defect", "interruption"] as const)(
    "reserves a pending manual run then settles %s without changing cadence",
    async (failure) => {
      const gate = Effect.runSync(Deferred.make<void>());
      const published = Effect.runSync(Deferred.make<void>());
      const fakeFire = Layer.succeed(
        ScheduleFire,
        ScheduleFire.of(() =>
          Deferred.await(gate).pipe(
            Effect.andThen(failure === "defect" ? Effect.die("fire crashed") : Effect.interrupt),
          ),
        ),
      );
      const fakeBus = Layer.succeed(
        SyncBus,
        SyncBus.of({
          publish: (_userId, event) =>
            event.type === "schedule.run.changed"
              ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
              : Effect.void,
        } as SyncBus["Service"]),
      );
      const serviceRuntime = ManagedRuntime.make(
        ScheduleService.layer.pipe(
          Layer.provideMerge(FeaturePolicy.layer),
          Layer.provideMerge(fakeFire),
          Layer.provideMerge(fakeBus),
          Layer.provideMerge(Layer.succeed(AgentRepo, {} as AgentRepo["Service"])),
          Layer.provideMerge(Layer.succeed(ProviderRepo, {} as ProviderRepo["Service"])),
          Layer.provideMerge(Db.layer),
          Layer.provideMerge(
            PgClient.layer({ url: Redacted.make(databaseUrl), maxConnections: 8 }),
          ),
        ),
      );
      try {
        const { owner, schedule } = await run(
          Effect.gen(function* () {
            const owner = yield* makeUser();
            return {
              owner,
              schedule: yield* insert(owner, { nextFireAt: new Date(Date.now() + 3_600_000) }),
            };
          }),
        );
        await serviceRuntime.runPromise(
          Effect.gen(function* () {
            const service = yield* ScheduleService;
            yield* service.runNow(owner, schedule.id);
          }),
        );
        const pending = await run(
          Effect.gen(function* () {
            const db = yield* Db;
            return yield* db
              .select()
              .from(scheduleRuns)
              .where(eq(scheduleRuns.scheduleId, schedule.id));
          }),
        );
        expect(pending).toMatchObject([{ status: "pending", conversationId: null }]);
        await serviceRuntime.runPromise(Deferred.succeed(gate, undefined));
        await serviceRuntime.runPromise(Deferred.await(published));
        const settled = await run(
          Effect.gen(function* () {
            const db = yield* Db;
            const [row] = yield* db
              .select()
              .from(scheduleRuns)
              .where(eq(scheduleRuns.scheduleId, schedule.id));
            const [unchanged] = yield* db
              .select()
              .from(schedules)
              .where(eq(schedules.id, schedule.id));
            return { row, unchanged };
          }),
        );
        expect(settled.row).toMatchObject({ status: "error", conversationId: null });
        expect(settled.unchanged?.nextFireAt).toEqual(schedule.nextFireAt);
      } finally {
        await serviceRuntime.dispose();
      }
    },
  );
});

describe("schedule removal", () => {
  it("cascades the run history with the schedule", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const row = yield* insert(userId);
        const pending = yield* repo.beginRun(row.id);
        yield* repo.finishRun(pending.id, "error", "no model");
        yield* repo.remove(userId, row.id);
        const runs = yield* db
          .select()
          .from(scheduleRuns)
          .where(eq(scheduleRuns.scheduleId, row.id));
        const [remaining] = yield* db
          .select()
          .from(schedules)
          .where(sql`${schedules.id} = ${row.id}`);
        return { runs: runs.length, gone: remaining === undefined };
      }),
    );
    expect(result).toEqual({ runs: 0, gone: true });
  });

  it("keeps a schedule's chats as ordinary chats when the schedule is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const row = yield* insert(userId);
        const created = yield* chat(userId, row.id);
        yield* repo.remove(userId, row.id);
        const [kept] = yield* db.select().from(conversations).where(eq(conversations.id, created));
        return kept;
      }),
    );
    expect(result).toMatchObject({ scheduleId: null });
  });

  it("adopts a same-chat schedule's first chat only while it still wants one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const same = yield* insert(userId, { chatMode: "same", chatId: null });
        const fresh = yield* insert(userId, { chatMode: "new" });
        const first = yield* chat(userId, same.id);
        const second = yield* chat(userId, same.id);
        yield* repo.adoptChat(same.id, first);
        // A later fire (or a race) never replaces the chat already in use.
        yield* repo.adoptChat(same.id, second);
        yield* repo.adoptChat(fresh.id, first);
        return {
          same: (yield* repo.get(userId, same.id))!.chatId,
          fresh: (yield* repo.get(userId, fresh.id))!.chatId,
          first,
        };
      }),
    );
    expect(result.same).toBe(result.first);
    expect(result.fresh).toBeNull();
  });

  it("only accepts the owner's plain chat as a schedule's chat", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const userId = yield* makeUser();
        const mine = yield* chat(userId);
        const theirs = yield* chat(yield* makeUser());
        const work = uuidv7();
        yield* db.insert(conversations).values({ id: work, userId, mode: "work" });
        const temporary = uuidv7();
        yield* db.insert(conversations).values({ id: temporary, userId, temporary: true });
        const check = (chatId: string) =>
          checkScheduleResources(db as never, userId, {
            skillIds: [],
            collectionIds: [],
            chatId,
          }).pipe(
            Effect.match({
              onFailure: (error) => ("reason" in error ? error.reason : "query failed"),
              onSuccess: () => "ok",
            }),
          );
        return {
          mine: yield* check(mine),
          theirs: yield* check(theirs),
          work: yield* check(work),
          temporary: yield* check(temporary),
        };
      }),
    );
    expect(result).toEqual({
      mine: "ok",
      theirs: "the selected chat is unavailable",
      work: "a work chat cannot run a schedule",
      temporary: "a temporary chat cannot run a schedule",
    });
  });

  it("finds the schedule running in a chat and forgets a chat that was deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const chosen = yield* chat(userId);
        const row = yield* insert(userId, { chatMode: "same", chatId: chosen });
        const found = yield* repo.findByChat(userId, chosen);
        const stranger = yield* repo.findByChat(yield* makeUser(), chosen);
        yield* db.delete(conversations).where(eq(conversations.id, chosen));
        return { found: found?.id, stranger, row: row.id, after: yield* repo.get(userId, row.id) };
      }),
    );
    expect(result.found).toBe(result.row);
    expect(result.stranger).toBeNull();
    // The next fire starts a new chat and adopts it.
    expect(result.after).toMatchObject({ chatMode: "same", chatId: null });
  });
});
