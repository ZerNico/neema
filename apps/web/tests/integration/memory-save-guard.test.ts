import { PgClient } from "@effect/sql-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversations, memories, messages, researchRuns, tools, user } from "~/db/schema/index.ts";
import {
  createResearchStore,
  initialResearchProgress,
  lockResearchFence,
  type ResearchFence,
} from "~/modules/chat/server/research/repo.ts";
import { hashSourceMessageContent } from "~/modules/memory/server/content-hash.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { isMemorySaveGuardFailure, MemorySaveGuard } from "~/modules/memory/server/save-guard.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<Db | MemoryRepo, unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const database = Db.layer.pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  runtime = ManagedRuntime.make(MemoryRepo.layer.pipe(Layer.provideMerge(database)));
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db.update(tools).set({ enabled: true }).where(eq(tools.name, "memory")).pipe(Effect.orDie),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

const fixture = async () => {
  const userId = uuidv7();
  const fence: ResearchFence = {
    conversationId: uuidv7(),
    messageId: uuidv7(),
    runId: uuidv7(),
    generationId: uuidv7(),
    owner: uuidv7(),
  };
  const sourceMessageId = uuidv7();
  const content = "I prefer concise answers";
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      Effect.gen(function* () {
        yield* db
          .insert(user)
          .values({ id: userId, name: "Memory fence", email: `${userId}@t.io` });
        yield* db.insert(conversations).values({ id: fence.conversationId, userId });
        yield* db.insert(messages).values([
          { id: sourceMessageId, conversationId: fence.conversationId, role: "user", content },
          {
            id: fence.messageId,
            conversationId: fence.conversationId,
            role: "assistant",
            status: "streaming",
            generationId: fence.generationId,
          },
        ]);
        yield* db.insert(researchRuns).values({
          id: fence.runId,
          conversationId: fence.conversationId,
          messageId: fence.messageId,
          generationId: fence.generationId,
          userId,
          owner: fence.owner,
          status: "running",
          progress: initialResearchProgress(fence.runId),
          modelId: "test-model",
          modelName: "Test model",
          leaseUntil: sql`clock_timestamp() + interval '5 minutes'`,
        });
      }).pipe(Effect.orDie),
    ),
  );
  const input = {
    content,
    contentHash: hashSourceMessageContent(content),
    sourceConversationId: fence.conversationId,
    sourceMessageId,
    sourceMessageHash: hashSourceMessageContent(content),
  };
  const save = Effect.flatMap(MemoryRepo, (repo) => repo.saveModel(userId, input));
  const list = () =>
    runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db.select().from(memories).where(eq(memories.userId, userId)).pipe(Effect.orDie),
      ),
    );
  return { userId, fence, save, list };
};

const expectGuardFailure = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(isMemorySaveGuardFailure(exit.cause)).toBe(true);
};

const connectController = async () => {
  const client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return { client, pid: rows[0]!.pid };
};

const waitForBlocked = async (client: Client, blocker: number) => {
  // Observe the database lock graph, not an elapsed-time guess about concurrent execution.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    const { rows } = await client.query<{ pid: number }>(
      "select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
      [blocker],
    );
    if (rows[0]) return rows[0].pid;
  }
  throw new Error("Memory transaction did not reach its lock barrier");
};

describe("memory save transaction fence", () => {
  it("saves with a valid fence and leaves ordinary saves on the default no-op guard", async () => {
    const first = await fixture();
    await expect(
      runtime.runPromise(
        first.save.pipe(
          Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, first.fence)),
        ),
      ),
    ).resolves.toMatchObject({ outcome: "created" });
    expect(await first.list()).toHaveLength(1);

    const second = await fixture();
    await runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db
          .update(researchRuns)
          .set({ cancelRequested: true })
          .where(eq(researchRuns.id, second.fence.runId))
          .pipe(Effect.orDie),
      ),
    );
    await expect(runtime.runPromise(second.save)).resolves.toMatchObject({ outcome: "created" });
    expect(await second.list()).toHaveLength(1);
  });

  it("preserves interruptions from the transaction guard without writing memory", async () => {
    const { save, list } = await fixture();
    const result = await runtime.runPromiseExit(
      save.pipe(Effect.provideService(MemorySaveGuard, () => Effect.interrupt)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.hasInterrupts(result.cause)).toBe(true);
    expect(await list()).toEqual([]);
  });

  it.each(["owner", "runId", "messageId", "conversationId", "generationId"] as const)(
    "rejects a mismatched %s without writing memory",
    async (field) => {
      const { fence, save, list } = await fixture();
      const stale = { ...fence, [field]: uuidv7() };
      expectGuardFailure(
        await runtime.runPromiseExit(
          save.pipe(Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, stale))),
        ),
      );
      expect(await list()).toEqual([]);
    },
  );

  it.each(["cancelled", "expired", "terminal", "message-complete", "superseded"] as const)(
    "rejects a %s run inside the write transaction",
    async (state) => {
      const { fence, save, list } = await fixture();
      await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          Effect.gen(function* () {
            if (state === "message-complete" || state === "superseded") {
              yield* db
                .update(messages)
                // A retry or edit mints a new generation id; that is what ends
                // this run's claim on the message, not a column pointing at it.
                .set(state === "superseded" ? { generationId: uuidv7() } : { status: "complete" })
                .where(eq(messages.id, fence.messageId));
            } else {
              yield* db
                .update(researchRuns)
                .set(
                  state === "cancelled"
                    ? { cancelRequested: true }
                    : state === "expired"
                      ? { leaseUntil: sql`clock_timestamp() - interval '1 second'` }
                      : { status: "terminal" },
                )
                .where(eq(researchRuns.id, fence.runId));
            }
          }).pipe(Effect.orDie),
        ),
      );
      expectGuardFailure(
        await runtime.runPromiseExit(
          save.pipe(Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, fence))),
        ),
      );
      expect(await list()).toEqual([]);
    },
  );

  it("holds the conversation fence through commit when save wins before Stop, before memory locks", async () => {
    const { fence, userId, save, list } = await fixture();
    const { client, pid } = await connectController();
    const store = createResearchStore(await runtime.runPromise(Db));
    let pendingSave: ReturnType<typeof runtime.runPromiseExit> | undefined;
    let stop: Promise<boolean> | undefined;
    try {
      await client.query("select pg_advisory_lock(hashtextextended($1, 91842))", [fence.runId]);
      pendingSave = runtime.runPromiseExit(
        save.pipe(
          Effect.provideService(MemorySaveGuard, (tx) =>
            Effect.gen(function* () {
              yield* lockResearchFence(tx, fence);
              yield* tx
                .execute(sql`select pg_advisory_xact_lock(hashtextextended(${fence.runId}, 91842))`)
                .pipe(Effect.orDie);
            }),
          ),
        ),
      );
      const savingPid = await waitForBlocked(client, pid);
      // The guard is already executing, but MemoryRepo must not yet own its user advisory lock.
      const { rows } = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
        [userId],
      );
      expect(rows[0]?.acquired).toBe(true);
      stop = runtime.runPromise(store.cancelForGeneration(fence.messageId, fence.generationId));
      await waitForBlocked(client, savingPid);
      await client.query("select pg_advisory_unlock_all()");
      expect(await pendingSave).toMatchObject({ _tag: "Success", value: { outcome: "created" } });
      expect(await stop).toBe(true);
      expect(await list()).toHaveLength(1);
      expectGuardFailure(
        await runtime.runPromiseExit(
          save.pipe(Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, fence))),
        ),
      );
      expect(await list()).toHaveLength(1);
    } finally {
      await client.query("select pg_advisory_unlock_all()");
      await Promise.allSettled([pendingSave, stop]);
      await client.end();
    }
  });

  it.each(["cancel", "owner", "lease", "retry"] as const)(
    "rejects the save when %s commits first while the save waits on the conversation lock",
    async (change) => {
      const { fence, save, list } = await fixture();
      const { client, pid } = await connectController();
      let pendingSave: ReturnType<typeof runtime.runPromiseExit> | undefined;
      try {
        await client.query("begin");
        // Stop/retry/ownership updates all serialize through this same conversation lock.
        await client.query("select id from conversations where id = $1 for update", [
          fence.conversationId,
        ]);
        if (change === "retry") {
          await client.query("update messages set generation_id = $1 where id = $2", [
            uuidv7(),
            fence.messageId,
          ]);
        } else {
          const assignment =
            change === "cancel"
              ? "cancel_requested = true"
              : change === "owner"
                ? "owner = 'replacement-owner'"
                : "lease_until = clock_timestamp() - interval '1 second'";
          await client.query(`update research_runs set ${assignment} where id = $1`, [fence.runId]);
        }
        pendingSave = runtime.runPromiseExit(
          save.pipe(Effect.provideService(MemorySaveGuard, (tx) => lockResearchFence(tx, fence))),
        );
        await waitForBlocked(client, pid);
        await client.query("commit");
        expectGuardFailure(await pendingSave);
        expect(await list()).toEqual([]);
      } finally {
        await client.query("rollback");
        await Promise.allSettled([pendingSave]);
        await client.end();
      }
    },
  );
});
