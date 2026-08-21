import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { Db } from "~/server/db.ts";

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | StreamEngine | SyncBus | Db, unknown>;

// Deterministic fake AI provider: streams 5 words with a small delay.
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  streamChat: () =>
    Stream.fromIterable(["alpha ", "beta ", "gamma ", "delta ", "epsilon"]).pipe(
      Stream.map((delta): ChatStreamPart => ({ type: "text-delta", id: "t", delta }) as never),
      Stream.tap(() => Effect.sleep("30 millis")),
      Stream.concat(
        Stream.make({
          type: "finish",
          reason: "stop",
          usage: { inputTokens: {}, outputTokens: {} },
        } as never as ChatStreamPart),
      ),
    ),
});

// Search is not exercised in these tests; a stub satisfies the layer graph.
const FakeWebSearch = Layer.succeed(WebSearchExecutor, {
  prepare: () => Effect.die("not available in tests"),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const PgLive = PgClient.layer({ url: Redacted.make(url), maxConnections: 5 });
  const InfraLayer = Db.layer.pipe(Layer.provideMerge(PgLive));
  const ReposLayer = ChatRepo.layer.pipe(Layer.provideMerge(InfraLayer));
  const AppLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(FakeGateway, FakeWebSearch, SyncBus.layer).pipe(
        Layer.provideMerge(ReposLayer),
      ),
    ),
  );
  runtime = ManagedRuntime.make(AppLayer);
  await runtime.runPromise(Effect.void);
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

const setupConversation = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const db = yield* Db;
  const userId = uuidv7();
  // repo has no user creation — insert the auth user row directly
  yield* db.execute(
    `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
  );
  const conversation = yield* repo.createConversation({ userId, modelId: null as never });
  yield* repo.insertMessage({ conversationId: conversation.id, role: "user", content: "hi" });
  const assistant = yield* repo.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    status: "streaming",
  });
  return { userId, conversation, assistant };
});

describe("resumable streaming pipeline", () => {
  it("persists chunks, finalizes the message, and replays for late subscribers", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* setupConversation;

        yield* engine.startGeneration({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
          searchEnabled: false,
        });

        // Live subscriber from the start
        const liveEvents = yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);

        // Late subscriber after completion: replay only, from seq 2
        const lateEvents = yield* engine.subscribe(assistant.id, 2).pipe(Stream.runCollect);

        const final = yield* repo.getMessage(assistant.id);
        const chunks = yield* repo.chunksAfter(assistant.id, 0);

        return {
          live: Array.from(liveEvents),
          late: Array.from(lateEvents),
          final,
          chunks,
        };
      }),
    );

    // All 5 chunks arrived in order, then done
    const liveChunks = result.live.filter((e) => e.kind === "chunk");
    expect(liveChunks.map((c) => (c.kind === "chunk" ? c.seq : -1))).toEqual([1, 2, 3, 4, 5]);
    expect(result.live.at(-1)).toMatchObject({ kind: "done", status: "complete" });

    // Late subscriber got only seq > 2 replayed from Postgres + done
    const lateChunks = result.late.filter((e) => e.kind === "chunk");
    expect(lateChunks.map((c) => (c.kind === "chunk" ? c.seq : -1))).toEqual([3, 4, 5]);
    expect(result.late.at(-1)).toMatchObject({ kind: "done", status: "complete" });

    // Message finalized with assembled content
    expect(result.final?.status).toBe("complete");
    expect(result.final?.content).toBe("alpha beta gamma delta epsilon");
    expect(result.chunks).toHaveLength(5);
  }, 60_000);

  it("fans out sync events across the bus (LISTEN/NOTIFY roundtrip)", async () => {
    const events = await runtime.runPromise(
      Effect.gen(function* () {
        const bus = yield* SyncBus;
        const userId = uuidv7();
        const collect = bus.subscribe(userId).pipe(Stream.take(1), Stream.runCollect);
        const collector = yield* Effect.forkChild(collect);
        yield* Effect.sleep("200 millis");
        yield* bus.publish(userId, { type: "conversation.created", conversationId: "c1" });
        return Array.from(yield* Fiber.join(collector));
      }),
    );
    expect(events).toEqual([{ type: "conversation.created", conversationId: "c1" }]);
  }, 30_000);
});
