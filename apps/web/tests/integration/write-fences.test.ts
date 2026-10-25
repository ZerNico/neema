import { PgClient } from "@effect/sql-pg";
import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversations, memories, messages, researchRuns, tools, user } from "~/db/schema/index.ts";
import {
  createResearchStore,
  initialResearchProgress,
  type ResearchFence,
} from "~/modules/chat/server/research/repo.ts";
import {
  lockGeneration,
  type GenerationIdentity,
} from "~/modules/chat/server/generation-fence.ts";
import { hashSourceMessageContent } from "~/modules/memory/server/content-hash.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Db | MemoryRepo, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  const dbLayer = Db.layer.pipe(
    Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  runtime = ManagedRuntime.make(MemoryRepo.layer.pipe(Layer.provideMerge(dbLayer)));
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      db.update(tools).set({ enabled: true }).where(eq(tools.name, "memory")).pipe(Effect.orDie),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

/** One streaming attempt, plus the run a `deep_research` call inside it started. */
const fixture = async () => {
  const userId = uuidv7();
  const identity: GenerationIdentity = {
    userId,
    conversationId: uuidv7(),
    messageId: uuidv7(),
    generationId: uuidv7(),
  };
  const fence: ResearchFence = {
    conversationId: identity.conversationId,
    messageId: identity.messageId,
    generationId: identity.generationId,
    runId: uuidv7(),
    owner: uuidv7(),
  };
  const sourceMessageId = uuidv7();
  const content = "I prefer concise answers";
  await runtime.runPromise(
    Effect.flatMap(Db, (db) =>
      Effect.gen(function* () {
        yield* db.insert(user).values({ id: userId, name: "Write fence", email: `${userId}@t.io` });
        yield* db.insert(conversations).values({ id: identity.conversationId, userId });
        yield* db.insert(messages).values([
          { id: sourceMessageId, conversationId: identity.conversationId, role: "user", content },
          {
            id: identity.messageId,
            conversationId: identity.conversationId,
            role: "assistant",
            status: "streaming",
            generationId: identity.generationId,
          },
        ]);
        yield* db.insert(researchRuns).values({
          id: fence.runId,
          conversationId: identity.conversationId,
          messageId: identity.messageId,
          generationId: identity.generationId,
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
    sourceConversationId: identity.conversationId,
    sourceMessageId,
    sourceMessageHash: hashSourceMessageContent(content),
  };
  const save = Effect.flatMap(MemoryRepo, (repo) =>
    repo.saveModel(userId, { ...input, guard: () => Effect.void }),
  );
  /** The model's save under an attempt's fence, as the memory tool makes it. */
  const saveAs = (owner: GenerationIdentity) =>
    Effect.flatMap(MemoryRepo, (repo) =>
      repo.saveModel(userId, { ...input, guard: (tx) => lockGeneration(tx, owner) }),
    );
  const fenced = saveAs(identity);
  const list = () =>
    runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db.select().from(memories).where(eq(memories.userId, userId)).pipe(Effect.orDie),
      ),
    );
  return { userId, identity, fence, save, saveAs, fenced, list };
};

/** A lost research fence dies with its own message rather than a typed failure. */
const expectResearchLoss = (exit: Exit.Exit<unknown, unknown>) =>
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
    message: "Research ownership lost or cancelled",
  });

/** A lost fence interrupts; it is never a recoverable failure the model hears about. */
const expectFenceLoss = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
};

const connectController = async () => {
  const client = new Client({ connectionString: database.url });
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

describe("memory saves under the generation fence", () => {
  it("saves inside a live attempt and saves manually with no attempt at all", async () => {
    const generated = await fixture();
    await expect(runtime.runPromise(generated.fenced)).resolves.toMatchObject({
      outcome: "created",
    });
    expect(await generated.list()).toHaveLength(1);

    // A manual save from the settings page belongs to no attempt: the fence
    // reference defaults to null and the write proceeds, as it does for every
    // other repository write outside a generation.
    const manual = await fixture();
    await expect(runtime.runPromise(manual.save)).resolves.toMatchObject({ outcome: "created" });
    expect(await manual.list()).toHaveLength(1);
  });

  it.each(["userId", "conversationId", "messageId", "generationId"] as const)(
    "rejects a mismatched %s without writing memory",
    async (field) => {
      const { identity, saveAs, list } = await fixture();
      expectFenceLoss(await runtime.runPromiseExit(saveAs({ ...identity, [field]: uuidv7() })));
      expect(await list()).toEqual([]);
    },
  );

  it.each(["complete", "superseded"] as const)(
    "rejects a %s attempt inside the write transaction",
    async (state) => {
      const { identity, fenced, list } = await fixture();
      await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .update(messages)
            // A retry or edit mints a new generation id; the reaper and normal
            // completion move the row out of `streaming`.
            .set(state === "superseded" ? { generationId: uuidv7() } : { status: "complete" })
            .where(eq(messages.id, identity.messageId))
            .pipe(Effect.orDie),
        ),
      );
      expectFenceLoss(await runtime.runPromiseExit(fenced));
      expect(await list()).toEqual([]);
    },
  );

  it("takes the fence before its own user lock, and holds it through commit", async () => {
    const { userId, identity, fenced, list } = await fixture();
    const { client, pid } = await connectController();
    let pendingSave: ReturnType<typeof runtime.runPromiseExit> | undefined;
    try {
      await client.query("begin");
      await client.query("select id from conversations where id = $1 for update", [
        identity.conversationId,
      ]);
      pendingSave = runtime.runPromiseExit(fenced);
      await waitForBlocked(client, pid);
      // Blocked on the conversation row, so the fence really does come first:
      // MemoryRepo cannot yet own its user advisory lock.
      const { rows } = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
        [userId],
      );
      expect(rows[0]?.acquired).toBe(true);
      await client.query("commit");
      expect(await pendingSave).toMatchObject({ _tag: "Success", value: { outcome: "created" } });
      expect(await list()).toHaveLength(1);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await Promise.allSettled([pendingSave]);
      await client.end();
    }
  });

  it.each(["retry", "finalize"] as const)(
    "rejects the save when %s commits first while it waits on the conversation lock",
    async (change) => {
      const { identity, fenced, list } = await fixture();
      const { client, pid } = await connectController();
      let pendingSave: ReturnType<typeof runtime.runPromiseExit> | undefined;
      try {
        await client.query("begin");
        // Stop, retry and finalize all serialize through this same lock.
        await client.query("select id from conversations where id = $1 for update", [
          identity.conversationId,
        ]);
        await (change === "retry"
          ? client.query("update messages set generation_id = $1 where id = $2", [
              uuidv7(),
              identity.messageId,
            ])
          : client.query("update messages set status = 'aborted' where id = $1", [
              identity.messageId,
            ]));
        pendingSave = runtime.runPromiseExit(fenced);
        await waitForBlocked(client, pid);
        await client.query("commit");
        expectFenceLoss(await pendingSave);
        expect(await list()).toEqual([]);
      } finally {
        await client.query("rollback").catch(() => undefined);
        await Promise.allSettled([pendingSave]);
        await client.end();
      }
    },
  );
});

describe("the research run's own fence", () => {
  const store = () => runtime.runPromise(Db).then(createResearchStore);
  const write = (fence: ResearchFence) =>
    store().then((research) =>
      runtime.runPromiseExit(
        research.locked(fence, (tx) =>
          tx
            .update(researchRuns)
            .set({ modelName: "touched" })
            .where(eq(researchRuns.id, fence.runId))
            .pipe(Effect.orDie, Effect.asVoid),
        ),
      ),
    );

  it("admits the owner it was claimed with", async () => {
    const { fence } = await fixture();
    expect(Exit.isSuccess(await write(fence))).toBe(true);
  });

  it.each(["owner", "runId", "messageId", "conversationId", "generationId"] as const)(
    "refuses a mismatched %s",
    async (field) => {
      const { fence } = await fixture();
      expectResearchLoss(await write({ ...fence, [field]: uuidv7() }));
    },
  );

  it.each(["cancelled", "expired", "terminal", "message-complete", "superseded"] as const)(
    "refuses a %s run",
    async (state) => {
      const { fence } = await fixture();
      await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          Effect.gen(function* () {
            if (state === "message-complete" || state === "superseded") {
              yield* db
                .update(messages)
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
      expectResearchLoss(await write(fence));
    },
  );
});
