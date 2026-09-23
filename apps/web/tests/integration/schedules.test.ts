import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { Deferred, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { execSync } from "node:child_process";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conversations,
  groupMembers,
  groups,
  scheduleRuns,
  schedules,
  user,
} from "~/db/schema/index.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleFire } from "~/modules/schedules/server/fire.ts";
import { ScheduleRepo, type ScheduleRow } from "~/modules/schedules/server/repo.ts";
import { ScheduleService } from "~/modules/schedules/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { checkScheduleResources } from "~/modules/schedules/server/validate.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
let databaseUrl: string;
let runtime: ManagedRuntime.ManagedRuntime<ScheduleRepo | Db, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, ScheduleRepo | Db>) =>
  runtime.runPromise(effect as never) as Promise<A>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  databaseUrl = url;
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  runtime = ManagedRuntime.make(
    ScheduleRepo.layer.pipe(
      Layer.provideMerge(Db.layer),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
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

describe("schedule capability revocation", () => {
  it("records a skipped fire without a chat, then fires after a regrant", async () => {
    let published = Effect.runSync(Deferred.make<void>());
    let fireCalls = 0;
    const fakeFire = Layer.effect(
      ScheduleFire,
      Effect.gen(function* () {
        const db = yield* Db;
        return ScheduleFire.of((row) =>
          Effect.gen(function* () {
            fireCalls++;
            const conversationId = uuidv7();
            yield* db
              .insert(conversations)
              .values({ id: conversationId, userId: row.userId, scheduleId: row.id })
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

describe("schedule removal", () => {
  it("cascades the run history with the schedule", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* ScheduleRepo;
        const db = yield* Db;
        const row = yield* insert(userId);
        yield* repo.recordRun({
          scheduleId: row.id,
          conversationId: null,
          status: "error",
          error: "no model",
        });
        yield* repo.remove(userId, row.id);
        const runs = yield* db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id));
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
        return { mine: yield* check(mine), theirs: yield* check(theirs), work: yield* check(work) };
      }),
    );
    expect(result).toEqual({
      mine: "ok",
      theirs: "the selected chat is unavailable",
      work: "a work chat cannot run a schedule",
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
