import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import type { ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { usageEvents } from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { generateConversationTitle, type TitleDeps } from "~/modules/chat/server/title.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { WebSearchExecutor, ToolUnavailable } from "~/modules/tools/server/web-search.ts";
import { Db } from "~/server/db.ts";

process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 7).toString("base64");

let container: StartedPostgreSqlContainer;
type Services =
  | AiGateway
  | AnalyticsRepo
  | ChatRepo
  | ChatService
  | ProviderRepo
  | StreamEngine
  | SyncBus
  | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let providerId: string;

// Per-test knobs for the fake provider's terminal finish part.
let finishUsage: { inputTokens: object; outputTokens: object } = {
  inputTokens: {},
  outputTokens: {},
};
let finishMetadata: unknown;
let failStream = false;

const makeUsage = (input: {
  inputTotal?: number;
  cacheRead?: number;
  outputTotal?: number;
  reasoning?: number;
}) => ({
  inputTokens: {
    ...(input.inputTotal !== undefined ? { total: input.inputTotal } : {}),
    ...(input.cacheRead !== undefined ? { cacheRead: input.cacheRead } : {}),
  },
  outputTokens: {
    ...(input.outputTotal !== undefined ? { total: input.outputTotal } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
  },
});

const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  generateText: () =>
    Effect.succeed({
      text: "A generated title",
      usage: new AiResponse.Usage({
        inputTokens: { uncached: undefined, total: 7, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 3, text: undefined, reasoning: undefined },
      }),
      finishMetadata,
    }),
  streamChat: () =>
    Stream.suspend(() => {
      if (failStream) {
        return Stream.make({ type: "text-delta", id: "t", delta: "part" } as never).pipe(
          Stream.concat(Stream.fail(new Error("provider blew up") as never)),
        ) as Stream.Stream<ChatStreamPart, never>;
      }
      return Stream.make(
        { type: "text-delta", id: "t", delta: "answer" } as never as ChatStreamPart,
        {
          type: "finish",
          reason: "stop",
          usage: finishUsage,
          metadata: finishMetadata,
        } as never as ChatStreamPart,
      );
    }),
});

const FakeBlobStore = Layer.succeed(BlobStore, {
  put: () => Effect.die("no blobs in these tests"),
  get: () => Effect.die("no blobs in these tests"),
  delete: () => Effect.void,
  exists: () => Effect.succeed(false),
  deletePrefix: () => Effect.void,
});

const FakeDocumentParser = Layer.succeed(DocumentParser, {
  parsePdf: () => Effect.die("no documents in these tests"),
  availability: () => Effect.succeed({ configured: false, enabled: false, kind: null }),
});

// Neither web tool is exercised in these tests. They report themselves
// unavailable the way a disabled tool really does — a typed ToolUnavailable,
// not a defect — so a tools-capable model here degrades instead of dying.
const unavailable = (tool: "web_search" | "read_url") => () =>
  Effect.fail(new ToolUnavailable({ tool, reason: "disabled" }));
const FakeWebSearch = Layer.succeed(WebSearchExecutor, {
  handler: unavailable("web_search"),
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});
const FakeUrlReader = Layer.succeed(UrlReaderExecutor, {
  handler: unavailable("read_url"),
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
  const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer, FakeBlobStore).pipe(
    Layer.provideMerge(PgLive),
  );
  const ReposLayer = Layer.mergeAll(AnalyticsRepo.layer, ChatRepo.layer, ProviderRepo.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(InfraLayer),
  );
  const EngineLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGateway,
        FakeWebSearch,
        FakeUrlReader,
        FakeBlobStore,
        FakeDocumentParser,
        SyncBus.layer,
      ).pipe(Layer.provideMerge(ReposLayer)),
    ),
  );
  runtime = ManagedRuntime.make(
    ChatService.layer.pipe(
      Layer.provideMerge(AttachmentService.layer.pipe(Layer.provideMerge(EngineLayer))),
    ),
  );

  providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, kind, base_url, api_key_ciphertext)
         values ('${providerId}', 'Prov', 'openrouter', 'http://x', 'x')` as never,
      );
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = Effect.fn("test.makeUser")(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
  );
  return userId;
});

const makeModel = Effect.fn("test.makeModel")(function* (
  options: { pricing?: { input: number; output: number } } = {},
) {
  const providers = yield* ProviderRepo;
  return yield* providers.createModel({
    providerId,
    modelKey: `key-${uuidv7()}`,
    displayName: `Model ${uuidv7().slice(-4)}`,
    type: "chat",
    contextLength: null,
    embeddingDimensions: null,
    capabilities: { reasoning: false, tools: false, vision: false, files: false },
    pricing: options.pricing ?? null,
    enabled: true,
    access: "public",
    groupIds: [],
  });
});

/** Sends a message and runs the generation to its terminal state. */
const generateOnce = Effect.fn("test.generateOnce")(function* (userId: string, modelId: string) {
  const chat = yield* ChatService;
  const engine = yield* StreamEngine;
  const turn = yield* chat.sendMessage({
    userId,
    conversationId: null,
    modelId,
    content: "hello there",
    searchEnabled: false,
    attachmentIds: [],
  });
  yield* engine.subscribe(turn.assistantMessageId, 0).pipe(Stream.runCollect);
  return turn;
});

const eventsForMessage = Effect.fn("test.eventsForMessage")(function* (messageId: string) {
  const db = yield* Db;
  return yield* db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.messageId, messageId))
    .orderBy(usageEvents.createdAt);
});

describe("usage ledger capture", () => {
  it("records one row per completed generation, provider-reported cost first", async () => {
    finishUsage = makeUsage({ inputTotal: 100, cacheRead: 20, outputTotal: 50, reasoning: 10 });
    finishMetadata = { openrouter: { usage: { cost: 0.0042 } } };
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        // Pricing present too — the provider-reported number must still win.
        const model = yield* makeModel({ pricing: { input: 2, output: 10 } });
        const turn = yield* generateOnce(userId, model.id);
        return {
          model,
          userId,
          conversationId: turn.conversationId,
          events: yield* eventsForMessage(turn.assistantMessageId),
        };
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      userId: result.userId,
      kind: "chat",
      status: "complete",
      modelId: result.model.id,
      modelName: result.model.displayName,
      conversationId: result.conversationId,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      reasoningTokens: 10,
      cost: 0.0042,
      costSource: "provider",
    });
  }, 60_000);

  it("computes cost from model pricing when the provider reports none", async () => {
    finishUsage = makeUsage({ inputTotal: 1000, outputTotal: 500 });
    finishMetadata = undefined;
    const events = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const model = yield* makeModel({ pricing: { input: 2, output: 10 } });
        const turn = yield* generateOnce(userId, model.id);
        return yield* eventsForMessage(turn.assistantMessageId);
      }),
    );
    // (1000 × $2 + 500 × $10) per 1M tokens
    expect(events[0]).toMatchObject({ cost: 0.007, costSource: "pricing" });
  }, 60_000);

  it("leaves cost honestly unknown without pricing or a provider number", async () => {
    finishUsage = makeUsage({ inputTotal: 10, outputTotal: 5 });
    finishMetadata = undefined;
    const events = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const model = yield* makeModel();
        const turn = yield* generateOnce(userId, model.id);
        return yield* eventsForMessage(turn.assistantMessageId);
      }),
    );
    expect(events[0]).toMatchObject({ cost: null, costSource: null });
  }, 60_000);

  it("appends a second row on retry instead of touching the first", async () => {
    finishUsage = makeUsage({ inputTotal: 10, outputTotal: 5 });
    finishMetadata = undefined;
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const userId = yield* makeUser();
        const model = yield* makeModel();
        const turn = yield* generateOnce(userId, model.id);

        finishUsage = makeUsage({ inputTotal: 30, outputTotal: 15 });
        yield* chat.retryMessage({
          userId,
          conversationId: turn.conversationId,
          messageId: turn.assistantMessageId,
        });
        yield* engine.subscribe(turn.assistantMessageId, 0).pipe(Stream.runCollect);
        return yield* eventsForMessage(turn.assistantMessageId);
      }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(result[1]).toMatchObject({ inputTokens: 30, outputTokens: 15 });
  }, 60_000);

  it("records a failed attempt with whatever was counted before the error", async () => {
    finishUsage = makeUsage({ inputTotal: 10, outputTotal: 5 });
    finishMetadata = undefined;
    failStream = true;
    try {
      const events = await run(
        Effect.gen(function* () {
          const userId = yield* makeUser();
          const model = yield* makeModel();
          const turn = yield* generateOnce(userId, model.id);
          return yield* eventsForMessage(turn.assistantMessageId);
        }),
      );
      // The stream died before its finish part, so tokens are zero — but the
      // attempt itself is on the ledger.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "error", inputTokens: 0, outputTokens: 0 });
    } finally {
      failStream = false;
    }
  }, 60_000);

  it("outlives conversation deletion and survives model deletion by name", async () => {
    finishUsage = makeUsage({ inputTotal: 10, outputTotal: 5 });
    finishMetadata = undefined;
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const providers = yield* ProviderRepo;
        const userId = yield* makeUser();
        const model = yield* makeModel();
        const turn = yield* generateOnce(userId, model.id);

        yield* repo.deleteConversation(userId, turn.conversationId);
        yield* providers.deleteModel(model.id);
        const events = yield* eventsForMessage(turn.assistantMessageId);
        return { events, modelName: model.displayName };
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ modelId: null, modelName: result.modelName });
  }, 60_000);

  it("records title generations as their own kind", async () => {
    finishMetadata = undefined;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const providers = yield* ProviderRepo;
        const analytics = yield* AnalyticsRepo;
        const userId = yield* makeUser();
        const model = yield* makeModel({ pricing: { input: 1, output: 1 } });
        const conversation = yield* repo.createConversation({ userId, modelId: model.id });

        const deps: TitleDeps = {
          gateway: (yield* AiGateway) as TitleDeps["gateway"],
          repo,
          sync: { publish: () => Effect.void } as unknown as TitleDeps["sync"],
          providers,
          analytics,
        };
        yield* generateConversationTitle(deps, {
          userId,
          conversationId: conversation.id,
          modelId: model.id,
          content: "hello",
          attachmentFileNames: [],
        });
        return yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.conversationId, conversation.id));
      }),
    );
    expect(result).toHaveLength(1);
    // 7 in + 3 out from the fake generateText, at $1/$1 per 1M
    expect(result[0]).toMatchObject({
      kind: "title",
      status: "complete",
      inputTokens: 7,
      outputTokens: 3,
      cost: 0.00001,
      costSource: "pricing",
    });
  }, 60_000);
});

describe("usage aggregates", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // A fixed window rather than "now minus 7 days": the edge assertions below
  // need boundaries they can place rows exactly on.
  const WINDOW_FROM = new Date("2026-06-10T00:00:00.000Z");
  const WINDOW_TO = new Date("2026-06-13T00:00:00.000Z");

  // Rows are seeded directly with explicit timestamps; all reads are scoped
  // to this user so parallel-running capture tests can't leak in.
  const seed = Effect.fn("test.seedAggregates")(function* () {
    const db = yield* Db;
    const userId = yield* makeUser();
    const today = new Date(WINDOW_TO.getTime() - DAY_MS / 2);
    const yesterday = new Date(today.getTime() - DAY_MS);
    const base = {
      userId,
      modelId: null,
      status: "complete" as const,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
    yield* db.insert(usageEvents).values([
      {
        ...base,
        id: uuidv7(),
        kind: "chat",
        modelName: "Alpha",
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
        reasoningTokens: 10,
        cost: 0.001,
        costSource: "provider",
        createdAt: yesterday,
      },
      {
        ...base,
        id: uuidv7(),
        kind: "chat",
        modelName: "Alpha",
        inputTokens: 200,
        outputTokens: 100,
        cachedInputTokens: 60,
        reasoningTokens: 25,
        cost: 0.002,
        costSource: "pricing",
        createdAt: today,
      },
      {
        ...base,
        id: uuidv7(),
        kind: "title",
        modelName: "Beta",
        inputTokens: 10,
        outputTokens: 5,
        cost: null,
        costSource: null,
        createdAt: today,
      },
    ]);
    return {
      userId,
      scope: { from: WINDOW_FROM, to: WINDOW_TO, userId },
      todayKey: today.toISOString().slice(0, 10),
      today,
    };
  });

  it("sums the summary and flags incomplete cost", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { scope } = yield* seed();
        return yield* analytics.summary(scope);
      }),
    );
    expect(result).toEqual({
      messages: 2, // titles counted in tokens, not messages
      // Every row, chat and title alike — this is the error-rate divisor.
      attempts: 3,
      titleGenerations: 1,
      compactionGenerations: 0,
      errorAttempts: 0,
      abortedAttempts: 0,
      inputTokens: 310,
      outputTokens: 155,
      // Cache reads live *inside* inputTokens; they are not an addend.
      cachedInputTokens: 100,
      reasoningTokens: 35,
      cost: 0.003,
      costComplete: false, // the title row has unknown cost
      activeUsers: 1,
    });
  });

  it("counts compaction summaries as their own generation kind", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const analytics = yield* AnalyticsRepo;
        const { userId, scope, today } = yield* seed();
        yield* db.insert(usageEvents).values({
          id: uuidv7(),
          userId,
          modelId: null,
          kind: "compaction",
          modelName: "Alpha",
          status: "complete",
          inputTokens: 5_000,
          outputTokens: 400,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          cost: 0.004,
          costSource: "provider",
          createdAt: today,
        });
        return yield* analytics.summary(scope);
      }),
    );
    // A compaction is an attempt and its tokens are real spend, but it is
    // neither a message the user sent nor a title.
    expect(result).toMatchObject({
      messages: 2,
      titleGenerations: 1,
      compactionGenerations: 1,
      attempts: 4,
      inputTokens: 5_310,
      outputTokens: 555,
    });
  });

  it("includes an event exactly on `from` and excludes one exactly on `to`", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const analytics = yield* AnalyticsRepo;
        const userId = yield* makeUser();
        const base = {
          userId,
          modelId: null,
          kind: "chat" as const,
          modelName: "Edge",
          status: "complete" as const,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          outputTokens: 0,
          cost: 0,
          costSource: "provider" as const,
        };
        yield* db.insert(usageEvents).values([
          { ...base, id: uuidv7(), inputTokens: 1, createdAt: WINDOW_FROM },
          // One millisecond inside the upper bound — must be counted.
          {
            ...base,
            id: uuidv7(),
            inputTokens: 10,
            createdAt: new Date(WINDOW_TO.getTime() - 1),
          },
          // Exactly on the exclusive bound — must not be.
          { ...base, id: uuidv7(), inputTokens: 100, createdAt: WINDOW_TO },
          // Just before the inclusive bound — must not be.
          {
            ...base,
            id: uuidv7(),
            inputTokens: 1000,
            createdAt: new Date(WINDOW_FROM.getTime() - 1),
          },
        ]);
        return yield* analytics.summary({ from: WINDOW_FROM, to: WINDOW_TO, userId });
      }),
    );
    // 1 + 10 only: the half-open window is [from, to).
    expect(result.inputTokens).toBe(11);
    expect(result.attempts).toBe(2);
  });

  it("counts errors across chat and title, and keeps aborted out of them", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const analytics = yield* AnalyticsRepo;
        const userId = yield* makeUser();
        const at = new Date(WINDOW_FROM.getTime() + DAY_MS / 2);
        const base = {
          userId,
          modelId: null,
          modelName: "Gamma",
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          costSource: "provider" as const,
          createdAt: at,
        };
        yield* db.insert(usageEvents).values([
          { ...base, id: uuidv7(), kind: "chat", status: "error" },
          // A failed *title* run is still a failed attempt — the rate would
          // be wrong if the divisor were chat-only.
          { ...base, id: uuidv7(), kind: "title", status: "error" },
          { ...base, id: uuidv7(), kind: "chat", status: "aborted" },
          { ...base, id: uuidv7(), kind: "chat", status: "complete" },
        ]);
        return yield* analytics.summary({ from: WINDOW_FROM, to: WINDOW_TO, userId });
      }),
    );
    expect(result).toMatchObject({
      attempts: 4,
      errorAttempts: 2,
      abortedAttempts: 1,
      messages: 3,
      titleGenerations: 1,
    });
  });

  it("returns zeros — and a complete cost — for a range with no events", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { userId } = yield* seed();
        // A window well before anything was seeded.
        return yield* analytics.summary({
          from: new Date("2026-01-01T00:00:00.000Z"),
          to: new Date("2026-01-08T00:00:00.000Z"),
          userId,
        });
      }),
    );
    expect(result).toEqual({
      messages: 0,
      attempts: 0,
      titleGenerations: 0,
      compactionGenerations: 0,
      errorAttempts: 0,
      abortedAttempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      // Nothing is unknown when nothing is there — the tile must not claim
      // "at least".
      costComplete: true,
      activeUsers: 0,
    });
  });

  it("sees only the preceding window from the prior scope", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { userId, scope } = yield* seed();
        const span = WINDOW_TO.getTime() - WINDOW_FROM.getTime();
        const previous = {
          from: new Date(WINDOW_FROM.getTime() - span),
          to: WINDOW_FROM,
          userId,
        };
        return {
          current: yield* analytics.summary(scope),
          previous: yield* analytics.summary(previous),
        };
      }),
    );
    expect(result.current.inputTokens).toBe(310);
    // Every seeded row sits in the current window; the baseline is empty.
    expect(result.previous.inputTokens).toBe(0);
    expect(result.previous.attempts).toBe(0);
  });

  it("buckets by UTC day and honours both bounds", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { userId, scope, todayKey, today } = yield* seed();
        const week = yield* analytics.daily(scope);
        const hour = yield* analytics.daily({
          from: new Date(today.getTime() - 60 * 60 * 1000),
          to: WINDOW_TO,
          userId,
        });
        return { week, hour, todayKey };
      }),
    );
    expect(result.week).toHaveLength(2);
    expect(result.week[1]).toMatchObject({
      day: result.todayKey,
      messages: 1,
      attempts: 2, // the chat row plus the title row
      errorAttempts: 0,
      inputTokens: 210,
      outputTokens: 105,
      cachedInputTokens: 60,
      reasoningTokens: 25,
    });
    // Tight bound sees only today's rows.
    expect(result.hour).toHaveLength(1);
  });

  it("groups by model and by user, ordered by tokens", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { userId, scope } = yield* seed();
        const byModel = yield* analytics.byModel(scope);
        const byUser = (yield* analytics.byUser({ from: WINDOW_FROM, to: WINDOW_TO })).filter(
          (row) => row.userId === userId,
        );
        return { byModel, byUser };
      }),
    );
    expect(result.byModel.map((m) => m.modelName)).toEqual(["Alpha", "Beta"]);
    expect(result.byModel[0]).toMatchObject({ messages: 2, inputTokens: 300, outputTokens: 150 });
    expect(result.byUser).toHaveLength(1);
    expect(result.byUser[0]).toMatchObject({ inputTokens: 310, outputTokens: 155, cost: 0.003 });
  });

  it("keeps one user's rows out of another's scope", async () => {
    const result = await run(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsRepo;
        const { scope } = yield* seed();
        const userB = yield* makeUser();
        return {
          a: yield* analytics.summary(scope),
          b: yield* analytics.summary({ ...scope, userId: userB }),
        };
      }),
    );
    expect(result.a.inputTokens).toBe(310);
    expect(result.b).toMatchObject({ messages: 0, inputTokens: 0, cost: 0, activeUsers: 0 });
  });
});
