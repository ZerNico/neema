import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { execSync } from "node:child_process";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduleRuns, schedules, user } from "~/db/schema/index.ts";
import { ScheduleRepo, type ScheduleRow } from "~/modules/schedules/server/repo.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<ScheduleRepo | Db, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, ScheduleRepo | Db>) =>
  runtime.runPromise(effect as never) as Promise<A>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
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
    collectionIds: [],
    skillIds: [],
    nextFireAt: null,
    ...changes,
  });
});

// The claim is the whole scheduler: due-ness by DB clock, SKIP LOCKED, and
// rescheduling from now, so downtime costs one catch-up fire.
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
        // A 20-minute cadence two hours behind: six missed instants, one claim.
        const row = yield* insert(userId, {
          cron: "*/20 * * * *",
          nextFireAt: new Date(Date.now() - 2 * 3_600_000),
        });
        const nextFor = () => new Date(Date.now() + 1_200_000);
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
        const runs = yield* db.select().from(scheduleRuns);
        const [remaining] = yield* db
          .select()
          .from(schedules)
          .where(sql`${schedules.id} = ${row.id}`);
        return { runs: runs.length, gone: remaining === undefined };
      }),
    );
    expect(result).toEqual({ runs: 0, gone: true });
  });
});
