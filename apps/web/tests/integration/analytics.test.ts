import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response as AiResponse } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import type { ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { usageEvents } from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { generateConversationTitle, type TitleDeps } from "~/modules/chat/server/title.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import {
  FakeBlobStore,
  FakeDocumentParser,
  FakeWebSearch,
  FakeUrlReader,
  FakeCustomToolRuntime,
  NoIntegrations,
} from "./unused-services.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

// Knowledge-backed generations are exercised in knowledge.test.ts; here no
// message carries a manifest, so the session is never opened.
const FakeKnowledge = Layer.mergeAll(
  Layer.succeed(KnowledgeSearch, {
    search: () => Effect.die("knowledge search is not part of this suite"),
    session: () => Effect.die("knowledge session is not part of this suite"),
  } as never),
  Layer.succeed(KnowledgeService, {} as never),
);

let database: TestDatabase;
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
let finishUsage: {
  inputTokens: { total?: number; cacheRead?: number };
  outputTokens: { total?: number; reasoning?: number };
} = {
  inputTokens: {},
  outputTokens: {},
};
let finishMetadata: AiResponse.ProviderMetadata | undefined;
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
    ...(input.reasoning !== undefined ? { imageOutput: false, reasoning: input.reasoning } : {}),
  },
});

const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  probeChatModel: () => Effect.die("no model probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
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
        AiResponse.makePart("text-delta", { id: "t", delta: "answer" }),
        AiResponse.makePart("finish", {
          reason: "stop",
          usage: new AiResponse.Usage(finishUsage),
          metadata: finishMetadata,
        }),
      );
    }),
});

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const PgLive = PgClient.layer({ url: Redacted.make(url), maxConnections: 5 });
  const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer, FakeBlobStore).pipe(
    Layer.provideMerge(PgLive),
  );
  const ReposLayer = Layer.mergeAll(
    AnalyticsRepo.layer,
    CustomToolRepo.layer,
    IntegrationRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
    ScheduleRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer, FeaturePolicy.layer)),
    Layer.provideMerge(InfraLayer),
  );
  const EngineLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGateway,
        FakeKnowledge,
        FakeWebSearch,
        FakeUrlReader,
        FakeBlobStore,
        FakeDocumentParser,
        FakeCustomToolRuntime,
        NoIntegrations,
        FakeMemoryService,
        ExternalCompletion.layer,
        SyncBus.layer,
        Layer.mergeAll(ScheduleDraftService.layer, AgentDraftService.layer).pipe(
          Layer.provideMerge(SyncBus.layer),
        ),
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
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'Prov', 'openrouter', 'http://x', 'x')` as never,
      );
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
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
    capabilities: {
      imageOutput: false,
      reasoning: false,
      tools: false,
      vision: false,
      files: false,
    },
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
    conversation: { kind: "new", id: uuidv7(), mode: "chat" },
    modelId,
    content: "hello there",
    searchEnabled: false,
    researchEnabled: false,
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
    finishMetadata = { modelClient: { cost: 0.0042 } };
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        // Pricing is present too, so the provider-reported number must still win.
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
      // The stream died before its finish part, so tokens are zero, but the
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
          sync: { publish: () => Effect.void } as TitleDeps["sync"],
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
        // The other rows leave it null, as rows older than the column do.
        cacheWriteTokens: 30,
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

  it("returns exact numeric token totals above 2^31 across every aggregate", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const analytics = yield* AnalyticsRepo;
        const userId = yield* makeUser();
        const base = {
          userId,
          modelId: null,
          kind: "chat" as const,
          modelName: `Large ${userId}`,
          status: "complete" as const,
          inputTokens: 1_500_000_001,
          outputTokens: 1_400_000_001,
          cachedInputTokens: 1_300_000_001,
          reasoningTokens: 1_200_000_001,
          cost: 0,
          costSource: "provider" as const,
          createdAt: WINDOW_FROM,
        };
        // Each column fits int, but both the aggregate and per-row input +
        // output exceed it. Group ordering must widen before adding too.
        yield* db.insert(usageEvents).values([
          { ...base, id: uuidv7() },
          { ...base, id: uuidv7() },
        ]);
        const scope = { from: WINDOW_FROM, to: WINDOW_TO, userId };
        return {
          summary: yield* analytics.summary(scope),
          daily: yield* analytics.daily(scope),
          models: yield* analytics.byModel(scope),
          users: (yield* analytics.byUser(scope)).filter((row) => row.userId === userId),
        };
      }),
    );
    const tokens = { inputTokens: 3_000_000_002, outputTokens: 2_800_000_002 };
    const detail = { ...tokens, cachedInputTokens: 2_600_000_002, reasoningTokens: 2_400_000_002 };
    expect(result.summary).toMatchObject(detail);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject(detail);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject(tokens);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject(tokens);
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
      // Every row, chat and title alike, since this is the error-rate divisor.
      attempts: 3,
      titleGenerations: 1,
      compactionGenerations: 0,
      errorAttempts: 0,
      abortedAttempts: 0,
      inputTokens: 310,
      outputTokens: 155,
      // Cache reads and writes live *inside* inputTokens; they are not addends.
      cachedInputTokens: 100,
      cacheWriteTokens: 30,
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
          // One millisecond inside the upper bound, so it must be counted.
          {
            ...base,
            id: uuidv7(),
            inputTokens: 10,
            createdAt: new Date(WINDOW_TO.getTime() - 1),
          },
          // Exactly on the exclusive bound, so it must not be.
          { ...base, id: uuidv7(), inputTokens: 100, createdAt: WINDOW_TO },
          // Just before the inclusive bound, so it must not be.
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
          // A failed *title* run is still a failed attempt, so the rate would
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

  it("returns zeros, and a complete cost, for a range with no events", async () => {
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
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      // Nothing is unknown when nothing is there, so the tile must not claim
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

describe("embedding ledger isolation", () => {
  it("includes provider costs and unknown attempts without manufacturing chat generations", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const analytics = yield* AnalyticsRepo;
        const base = {
          userId,
          modelId: null,
          modelName: "Embedding model",
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: null,
          reasoningTokens: 0,
        };
        yield* analytics.record({
          ...base,
          kind: "embedding_document",
          status: "complete",
          inputTokens: 1000,
          usageComplete: true,
          cost: 0.02,
          costSource: "pricing",
        });
        yield* analytics.record({
          ...base,
          kind: "embedding_query",
          status: "aborted",
          inputTokens: 0,
          usageComplete: false,
          cost: null,
          costSource: null,
        });
        const scope = { userId, from: new Date(0), to: new Date(Date.now() + 60_000) };
        const db = yield* Db;
        return {
          summary: yield* analytics.summary(scope),
          daily: yield* analytics.daily(scope),
          models: yield* analytics.byModel(scope),
          events: yield* db.select().from(usageEvents).where(eq(usageEvents.userId, userId)),
        };
      }),
    );
    expect(result.summary).toMatchObject({
      messages: 0,
      titleGenerations: 0,
      compactionGenerations: 0,
      attempts: 2,
      abortedAttempts: 1,
      inputTokens: 1000,
      outputTokens: 0,
      cost: 0.02,
      costComplete: false,
    });
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({ messages: 0, attempts: 2, cost: 0.02 });
    expect(result.models).toEqual([
      { modelName: "Embedding model", messages: 0, inputTokens: 1000, outputTokens: 0, cost: 0.02 },
    ]);
    expect(result.events).toHaveLength(2);
    for (const event of result.events) {
      expect(event.conversationId).toBeNull();
      expect(event.messageId).toBeNull();
    }
  });
});
