import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { FakeCustomToolRuntime } from "./unused-services.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Prompt, Response as AiResponse } from "effect/unstable/ai";
import { uuidv7 } from "uuidv7";
import {
  conversationCompactionCheckpoints,
  attachmentBlobs,
  attachments,
  messageAttachments,
  messages as messagesTable,
  models,
  usageEvents,
} from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { BlobStoreError, DocumentParseError } from "~/modules/attachments/errors.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import {
  estimatePromptTokens,
  latestValidCheckpoint,
  prepareCompactedHistory,
  type CompactionDeps,
} from "~/modules/chat/server/compaction.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import {
  AiGateway,
  ProviderContextOverflow,
  ProviderUnreachable,
  type ChatStreamPart,
} from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { Db } from "~/server/db.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

// ProviderRepo decrypts stored keys through KeyCipher, which reads this.
process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 7).toString("base64");

// Knowledge-backed generations are exercised in knowledge.test.ts; here no
// message carries a manifest, so the session is never opened.
const FakeKnowledge = Layer.mergeAll(
  Layer.succeed(KnowledgeSearch, {
    search: () => Effect.die("knowledge search is not part of this suite"),
    session: () => Effect.die("knowledge session is not part of this suite"),
  } as never),
  Layer.succeed(KnowledgeService, {} as never),
);

let container: StartedPostgreSqlContainer;
/** No declared window: the estimator falls back to its default. */
let modelId: string;
/** A window small enough that a handful of long turns overflow it. */
let smallModelId: string;
/** Enough room for the full tool catalog before an active round expands it. */
let toolModelId: string;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | AnalyticsRepo | StreamEngine | Db, unknown>;

/**
 * The one fake in the end-to-end block: every prompt the engine would have
 * sent, plus switches for the two provider behaviours worth exercising:
 * a refused oversized prompt, and a model that cannot write a summary.
 */
const gateway = {
  streamPrompts: [] as string[],
  summaryPrompts: [] as string[],
  summary: "SUMMARY OF EARLIER TURNS",
  summaryFails: false,
  toolRoundResult: null as string | null,
  overflowOnCalls: [] as number[],
  partialOverflowOnCalls: [] as number[],
  /** How many stream calls to reject as too long before letting one through. */
  overflowsLeft: 0,
  /** What the provider claims it counted, so calibration has something real. */
  reportedInputTokens: 9_999,
  reset() {
    gateway.streamPrompts = [];
    gateway.summaryPrompts = [];
    gateway.summary = "SUMMARY OF EARLIER TURNS";
    gateway.summaryFails = false;
    gateway.toolRoundResult = null;
    gateway.overflowOnCalls = [];
    gateway.partialOverflowOnCalls = [];
    gateway.overflowsLeft = 0;
    gateway.reportedInputTokens = 9_999;
  },
};

const TOOL_SOURCE_URL = "https://example.com/current-source";

const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
  generateText: (input) =>
    Effect.suspend(() => {
      gateway.summaryPrompts.push(JSON.stringify(input.prompt));
      return gateway.summaryFails
        ? Effect.fail(new ProviderUnreachable({ providerId: "p", message: "summary died" }))
        : Effect.succeed({
            text: gateway.summary,
            usage: emptyUsage(),
            finishMetadata: undefined,
          });
    }),
  streamChat: (input) =>
    Stream.suspend(() => {
      gateway.streamPrompts.push(JSON.stringify(input.prompt));
      const callNumber = gateway.streamPrompts.length;
      const overflow = () =>
        new ProviderContextOverflow({ providerId: "p", message: "maximum context length" });
      if (gateway.partialOverflowOnCalls.includes(callNumber)) {
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "partial", delta: "partial" }),
        ).pipe(Stream.concat(Stream.fail(overflow())));
      }
      if (gateway.overflowsLeft > 0 || gateway.overflowOnCalls.includes(callNumber)) {
        if (gateway.overflowsLeft > 0) gateway.overflowsLeft -= 1;
        return Stream.fail(overflow());
      }
      if (gateway.toolRoundResult !== null && gateway.streamPrompts.length === 1) {
        const result = {
          ok: true,
          targets: ["large context probe"],
          resultCount: 1,
          pagesFetched: 0,
          results: [
            {
              index: 1,
              url: TOOL_SOURCE_URL,
              title: "Current source",
              snippet: "A source discovered during this generation.",
              body: gateway.toolRoundResult,
            },
          ],
          failures: [],
          sources: [
            {
              kind: "web" as const,
              index: 1,
              url: TOOL_SOURCE_URL,
              title: "Current source",
              snippet: "A source discovered during this generation.",
              read: false,
            },
          ],
        };
        return Stream.make(
          AiResponse.makePart("tool-call", {
            id: "call_1",
            name: "web_search",
            params: { queries: ["large context probe"] },
            providerExecuted: false,
          }) as ChatStreamPart,
          AiResponse.toolResultPart({
            id: "call_1",
            name: "web_search",
            isFailure: false,
            result,
            encodedResult: result,
            providerExecuted: false,
            preliminary: false,
          }) as ChatStreamPart,
          AiResponse.makePart("finish", {
            reason: "tool-calls",
            usage: new AiResponse.Usage({
              inputTokens: { total: gateway.reportedInputTokens },
              outputTokens: { total: 12 },
            }),
          }),
        );
      }
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "answered" }),
        AiResponse.makePart("finish", {
          reason: "stop",
          usage: new AiResponse.Usage({
            inputTokens: { total: gateway.reportedInputTokens },
            outputTokens: { total: 12 },
          }),
        }),
      );
    }),
});

const getBlob = vi.fn<BlobStore["Service"]["get"]>((key) =>
  Effect.fail(new BlobStoreError({ operation: "get", key, message: "missing blob" })),
);
const parsePdf = vi.fn<DocumentParser["Service"]["parsePdf"]>(() =>
  Effect.die("covered documents must not be parsed"),
);
const parserAvailability = vi.fn<DocumentParser["Service"]["availability"]>(() =>
  Effect.succeed({ configured: true, enabled: true, kind: "test-parser" }),
);
const FakeBlobStore = Layer.succeed(BlobStore, {
  put: () => Effect.die("no blob writes in these tests"),
  get: getBlob,
  delete: () => Effect.void,
  exists: () => Effect.succeed(false),
  deletePrefix: () => Effect.void,
});
const FakeDocumentParser = Layer.succeed(DocumentParser, {
  parsePdf,
  availability: parserAvailability,
});
const unavailable = (tool: "web_search" | "read_url") => () =>
  Effect.fail(new ToolUnavailable({ tool, reason: "disabled" }));
const FakeWebSearch = Layer.succeed(WebSearchExecutor, {
  researchSearchLimit: () => Effect.die("no research in these tests"),
  handler: () =>
    Effect.succeed((params: { readonly queries: ReadonlyArray<string> }) =>
      Effect.succeed({
        ok: true as const,
        targets: params.queries,
        resultCount: 0,
        pagesFetched: 0,
        results: [],
        failures: [],
        sources: [],
      }),
    ),
  availability: () => Effect.succeed({ configured: true, enabled: true }),
});
const readerHandler = vi.fn<UrlReaderExecutor["Service"]["handler"]>(unavailable("read_url"));
const FakeUrlReader = Layer.succeed(UrlReaderExecutor, {
  handler: readerHandler,
  availability: () => Effect.succeed({ configured: false, enabled: false }),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  const ReposLayer = Layer.mergeAll(
    AnalyticsRepo.layer,
    ChatRepo.layer,
    CustomToolRepo.layer,
    ProviderRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(InfraLayer),
  );
  const AppLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGateway,
        FakeKnowledge,
        FakeWebSearch,
        FakeUrlReader,
        FakeBlobStore,
        FakeDocumentParser,
        FakeCustomToolRuntime,
        FakeMemoryService,
        ExternalCompletion.layer,
        SyncBus.layer,
      ).pipe(Layer.provideMerge(ReposLayer)),
    ),
  );
  runtime = ManagedRuntime.make(AppLayer);

  modelId = uuidv7();
  smallModelId = uuidv7();
  toolModelId = uuidv7();
  const providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, kind, base_url, api_key_ciphertext)
         values ('${providerId}', 'p', 'openrouter', 'http://x', 'x')` as never,
      );
      yield* db.insert(models).values([
        { id: modelId, providerId, modelKey: "m", displayName: "M", type: "chat" },
        {
          id: smallModelId,
          providerId,
          modelKey: "small",
          displayName: "Small Window",
          type: "chat",
          contextLength: TINY_CONTEXT,
          capabilities: { reasoning: false, tools: true, vision: false, files: false },
        },
        {
          id: toolModelId,
          providerId,
          modelKey: "tool-small",
          displayName: "Small Tool Window",
          type: "chat",
          contextLength: 8_000,
          capabilities: { reasoning: false, tools: true, vision: false, files: false },
        },
      ]);
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await container?.stop();
});

const run = <A, E>(effect: Effect.Effect<A, E, ChatRepo | AnalyticsRepo | StreamEngine | Db>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = Effect.fn("test.makeUser")(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
  );
  return userId;
});

const emptyUsage = () =>
  new AiResponse.Usage({
    inputTokens: {
      uncached: undefined,
      total: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  });

/**
 * A conversation of completed turns, alternating user/assistant. Every message
 * is long enough that a handful of them blow past the tiny window the tests
 * configure, so the trigger fires on message count rather than on prose luck.
 */
const seedConversation = Effect.fn("test.seedConversation")(function* (
  userId: string,
  turns: number,
) {
  const repo = yield* ChatRepo;
  const first = yield* repo.createTurn({
    userId,
    conversationId: null,
    modelId,
    content: `question 0 ${"x".repeat(2000)}`,
    attachmentIds: [],
  });
  yield* repo.finalizeMessage({
    messageId: first.assistant.id,
    status: "complete",
    content: `answer 0 ${"y".repeat(2000)}`,
  });
  for (let turn = 1; turn < turns; turn++) {
    const next = yield* repo.createTurn({
      userId,
      conversationId: first.conversation.id,
      modelId,
      content: `question ${turn} ${"x".repeat(2000)}`,
      attachmentIds: [],
    });
    yield* repo.finalizeMessage({
      messageId: next.assistant.id,
      status: "complete",
      content: `answer ${turn} ${"y".repeat(2000)}`,
    });
  }
  return first.conversation.id;
});

/** The real repo and ledger; only the model is faked. */
const depsWith = (
  repo: ChatRepo["Service"],
  analytics: AnalyticsRepo["Service"],
  summary: string,
) => {
  const generateText = vi.fn((_call: { modelId: string; prompt: Prompt.Prompt }) =>
    Effect.succeed({ text: summary, usage: emptyUsage(), finishMetadata: undefined }),
  );
  const deps: CompactionDeps = {
    gateway: { generateText },
    repo,
    providers: { getModel: () => Effect.succeed(null) },
    analytics,
  };
  return { deps, generateText };
};

const historyOf = Effect.fn("test.historyOf")(function* (conversationId: string) {
  const repo = yield* ChatRepo;
  const rows = yield* repo.listMessages(conversationId);
  return {
    messageId: rows.filter((m) => m.role === "assistant").at(-1)!.id,
    messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    renderedMessages: rows.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: [{ type: "text" as const, text: m.content }],
    })),
  };
});

/** Small enough that half a dozen 400-character turns cannot fit. */
const TINY_CONTEXT = 4_000;

const prepare = Effect.fn("test.prepare")(function* (input: {
  userId: string;
  conversationId: string;
  summary?: string;
}) {
  const repo = yield* ChatRepo;
  const analytics = yield* AnalyticsRepo;
  const { deps, generateText } = depsWith(
    repo,
    analytics,
    input.summary ?? "Earlier: they set up the database and picked Postgres 17.",
  );
  const fullHistory = yield* historyOf(input.conversationId);
  const selected = latestValidCheckpoint(
    fullHistory.messages,
    yield* repo.listCompactionCheckpoints(input.conversationId),
  );
  const start = selected ? selected.index + 1 : 0;
  const history = {
    ...fullHistory,
    messages: fullHistory.messages.slice(start),
    renderedMessages: fullHistory.renderedMessages.slice(start),
  };
  const decision = yield* prepareCompactedHistory(deps, {
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: history.messageId,
    modelId,
    contextLength: TINY_CONTEXT,
    existingCheckpoint: selected?.checkpoint ?? null,
    messages: history.messages,
    renderedMessages: history.renderedMessages,
    fixedPrefix: [],
    webToolsEnabled: false,
  });
  return { decision, generateText, history };
});

const checkpointsOf = Effect.fn("test.checkpointsOf")(function* (conversationId: string) {
  const db = yield* Db;
  return yield* db
    .select()
    .from(conversationCompactionCheckpoints)
    .where(eq(conversationCompactionCheckpoints.conversationId, conversationId))
    .orderBy(conversationCompactionCheckpoints.createdAt);
});

describe("context compaction", () => {
  it("summarizes past the trigger and leaves the stored transcript untouched", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const before = yield* historyOf(conversationId);
        const { decision, generateText } = yield* prepare({ userId, conversationId });
        return {
          decision,
          promptedWith: generateText.mock.calls.length,
          rows: yield* checkpointsOf(conversationId),
          after: yield* historyOf(conversationId),
          before,
        };
      }),
    );

    expect(result.decision.mode).toBe("checkpoint");
    expect(result.promptedWith).toBe(1);
    expect(result.rows).toHaveLength(1);
    // The boundary is a real message, and the verbatim tail starts right after.
    const boundaryIndex = result.before.messages.findIndex(
      (m) => m.id === result.rows[0]!.throughMessageId,
    );
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(result.decision.startIndex).toBe(boundaryIndex + 1);
    // The tail always opens on a question, never mid-turn.
    expect(result.before.messages[result.decision.startIndex]!.role).toBe("user");
    expect(result.decision.injectedMessages).toHaveLength(1);
    // Nothing was rewritten, deleted, or reordered.
    expect(result.after.messages).toEqual(result.before.messages);
  });

  it("folds the previous summary into the next one and keeps both rows", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const first = yield* prepare({ userId, conversationId, summary: "FIRST SUMMARY" });

        // More turns, so the next pass has to advance the boundary again.
        for (let turn = 8; turn < 14; turn++) {
          const next = yield* repo.createTurn({
            userId,
            conversationId,
            modelId,
            content: `question ${turn} ${"x".repeat(2000)}`,
            attachmentIds: [],
          });
          yield* repo.finalizeMessage({
            messageId: next.assistant.id,
            status: "complete",
            content: `answer ${turn} ${"y".repeat(2000)}`,
          });
        }

        const second = yield* prepare({ userId, conversationId, summary: "SECOND SUMMARY" });
        expect(second.decision.checkpoint!.throughMessageId).toBe(
          second.history.messages[second.decision.startIndex - 1]!.id,
        );
        expect(first.decision.startIndex).toBeGreaterThan(0);
        const rows = yield* checkpointsOf(conversationId);
        const history = yield* historyOf(conversationId);
        const position = (id: string) => history.messages.findIndex((m) => m.id === id);
        return {
          firstBoundary: position(first.decision.checkpoint!.throughMessageId),
          secondBoundary: position(second.decision.checkpoint!.throughMessageId),
          rows: rows.length,
          secondPrompt: JSON.stringify(second.generateText.mock.calls[0]![0].prompt),
          injected: JSON.stringify(second.decision.injectedMessages),
        };
      }),
    );

    expect(result.rows).toBe(2); // superseded rows are kept, for branches
    expect(result.secondBoundary).toBeGreaterThan(result.firstBoundary);
    // Progressive, not from scratch: the second pass is told what the first
    // one concluded and only reads what has aged since.
    expect(result.secondPrompt).toContain("FIRST SUMMARY");
    expect(result.injected).toContain("SECOND SUMMARY");
    expect(result.injected).not.toContain("FIRST SUMMARY");
  });

  it("records one compaction row in the ledger per summary", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        yield* prepare({ userId, conversationId });
        return yield* db
          .select({ kind: usageEvents.kind, status: usageEvents.status })
          .from(usageEvents)
          .where(eq(usageEvents.conversationId, conversationId));
      }),
    );
    expect(rows).toEqual([{ kind: "compaction", status: "complete" }]);
  });

  it("falls back to truncation when the model cannot produce a summary", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const analytics = yield* AnalyticsRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const history = yield* historyOf(conversationId);
        const deps: CompactionDeps = {
          gateway: {
            generateText: () =>
              Effect.fail(
                new (class extends Error {
                  readonly _tag = "ProviderUnreachable";
                })("nope") as never,
              ),
          },
          repo,
          providers: { getModel: () => Effect.succeed(null) },
          analytics,
        };
        const decision = yield* prepareCompactedHistory(deps, {
          userId,
          conversationId,
          messageId: history.messageId,
          modelId,
          contextLength: TINY_CONTEXT,
          existingCheckpoint: null,
          messages: history.messages,
          renderedMessages: history.renderedMessages,
          fixedPrefix: [],
          webToolsEnabled: false,
        });
        const ledger = yield* db
          .select({ kind: usageEvents.kind, status: usageEvents.status })
          .from(usageEvents)
          .where(eq(usageEvents.conversationId, conversationId));
        return {
          decision,
          ledger,
          checkpoints: yield* checkpointsOf(conversationId),
          count: history.messages.length,
        };
      }),
    );

    // The answer still gets generated, just against fewer turns.
    expect(result.decision.mode).toBe("truncated");
    expect(result.decision.startIndex).toBeGreaterThan(0);
    expect(result.decision.estimatedInputTokens).toBeLessThanOrEqual(result.decision.budget.input);
    expect(result.checkpoints).toHaveLength(0);
    expect(result.ledger).toEqual([{ kind: "compaction", status: "error" }]);
  });

  it("drops a checkpoint whose boundary a retry rewinds, in the same transaction", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const { decision } = yield* prepare({ userId, conversationId });
        const boundaryId = decision.checkpoint!.throughMessageId;
        const history = yield* historyOf(conversationId);
        const index = history.messages.findIndex((m) => m.id === boundaryId);

        // Retrying the boundary message itself: the row survives with its id,
        // so only the explicit invalidation can clear the summary.
        const target =
          history.messages[index]!.role === "assistant"
            ? history.messages[index]!
            : history.messages[index + 1]!;
        const targetIndex = history.messages.indexOf(target);
        yield* repo.resetMessageForRetry({
          expectedMessages: yield* repo.listMessages(conversationId),
          userId,
          messageId: target.id,
          modelId,
          deleteMessageIds: history.messages.slice(targetIndex + 1).map((m) => m.id),
          invalidateCheckpointThroughMessageIds: history.messages
            .slice(targetIndex)
            .map((m) => m.id),
        });
        return {
          remaining: yield* checkpointsOf(conversationId),
          boundaryStillThere: (yield* repo.getMessage(boundaryId)) !== null,
        };
      }),
    );
    expect(result.boundaryStillThere).toBe(true);
    expect(result.remaining).toHaveLength(0);
  });

  it("removes prior compaction activity when retry reuses an assistant row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        yield* prepare({ userId, conversationId });
        const history = yield* historyOf(conversationId);
        const messageId = history.messageId;
        const before = yield* repo.listCompactionEvents([messageId]);

        yield* repo.resetMessageForRetry({
          expectedMessages: yield* repo.listMessages(conversationId),
          userId,
          messageId,
          modelId,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
        });

        return {
          before,
          after: yield* repo.listCompactionEvents([messageId]),
        };
      }),
    );

    expect(result.before).toHaveLength(1);
    expect(result.after).toHaveLength(0);
  });

  it("copies only the checkpoints inside a branch's prefix, with fresh ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const { decision } = yield* prepare({ userId, conversationId });
        const source = decision.checkpoint!;
        // Ensure there is an unambiguous later boundary beyond a valid fork
        // point, regardless of how tightly the planner sized the first tail.
        for (let turn = 8; turn < 10; turn++) {
          const next = yield* repo.createTurn({
            userId,
            conversationId,
            modelId,
            content: `question ${turn} ${"x".repeat(2000)}`,
            attachmentIds: [],
          });
          yield* repo.finalizeMessage({
            messageId: next.assistant.id,
            status: "complete",
            content: `answer ${turn} ${"y".repeat(2000)}`,
          });
        }
        const history = yield* historyOf(conversationId);
        const boundaryIndex = history.messages.findIndex((m) => m.id === source.throughMessageId);

        // A checkpoint the branch cuts *before*: it describes messages the
        // copy does not have, so it must not come along.
        const laterBoundary = history.messages.at(-2)!;
        yield* repo.insertCompactionCheckpoint({
          conversationId,
          throughMessageId: laterBoundary.id,
          modelId,
          summary: "TOO LATE",
        });

        // Fork just after the first boundary, before the later one. Branching
        // is only allowed from an assistant message, so take the next one.
        const forkPoint = history.messages.find(
          (m, index) => index > boundaryIndex && m.role === "assistant",
        )!;
        const branch = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: conversationId,
          throughMessageId: forkPoint.id,
        });
        const copied = yield* checkpointsOf(branch.id);
        const branchHistory = yield* historyOf(branch.id);
        return {
          copied,
          source,
          remappedIsInBranch: branchHistory.messages.some(
            (m) => m.id === copied[0]?.throughMessageId,
          ),
        };
      }),
    );

    expect(result.copied).toHaveLength(1);
    expect(result.copied[0]!.summary).toBe(result.source.summary);
    expect(result.copied[0]!.id).not.toBe(result.source.id);
    // The boundary was remapped onto the clone, not left pointing at the source.
    expect(result.copied[0]!.throughMessageId).not.toBe(result.source.throughMessageId);
    expect(result.remappedIsInBranch).toBe(true);
  });

  it("copies completed compaction activity onto the cloned assistant", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        yield* prepare({ userId, conversationId });
        const sourceHistory = yield* historyOf(conversationId);
        const sourceEvent = (yield* repo.listCompactionEvents([sourceHistory.messageId]))[0]!;

        const branch = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: conversationId,
          throughMessageId: sourceHistory.messageId,
        });
        const branchHistory = yield* historyOf(branch.id);
        const branchEvent = (yield* repo.listCompactionEvents([branchHistory.messageId]))[0]!;
        const branchCheckpoints = yield* checkpointsOf(branch.id);

        return { sourceEvent, branchEvent, branchCheckpoints };
      }),
    );

    expect(result.branchEvent).toMatchObject({
      status: "complete",
      outcome: result.sourceEvent.outcome,
      beforeTurnIndex: result.sourceEvent.beforeTurnIndex,
      passIndex: result.sourceEvent.passIndex,
      textOffset: result.sourceEvent.textOffset,
    });
    expect(result.branchEvent.id).not.toBe(result.sourceEvent.id);
    expect(result.branchEvent.messageId).not.toBe(result.sourceEvent.messageId);
    expect(result.branchEvent.checkpointId).toBe(result.branchCheckpoints[0]?.id);
    expect(result.branchEvent.checkpointId).not.toBe(result.sourceEvent.checkpointId);
  });

  it("loses a checkpoint when its boundary message is deleted", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const { decision } = yield* prepare({ userId, conversationId });
        yield* repo.deleteMessages([decision.checkpoint!.throughMessageId]);
        return yield* checkpointsOf(conversationId);
      }),
    );
    expect(remaining).toHaveLength(0);
  });

  it("orders messages by (created_at, id) when timestamps collide", async () => {
    const order = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 2);
        // uuidv7 is time-ordered, so ascending ids are insertion order.
        const ids = [uuidv7(), uuidv7(), uuidv7()];
        const stamp = new Date("2026-08-24T10:00:00.000Z");
        for (const id of ids) {
          yield* db.insert(messagesTable).values({
            id,
            conversationId,
            role: "user",
            content: id,
            createdAt: stamp,
          });
        }
        const rows = yield* repo.listMessages(conversationId);
        return { seen: rows.filter((m) => ids.includes(m.id)).map((m) => m.id), ids };
      }),
    );
    // Insertion order, not whatever order Postgres felt like returning.
    expect(order.seen).toEqual(order.ids);
  });

  it("leaves a short conversation entirely alone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 2);
        const repo = yield* ChatRepo;
        const analytics = yield* AnalyticsRepo;
        const { deps, generateText } = depsWith(repo, analytics, "unused");
        const history = yield* historyOf(conversationId);
        const decision = yield* prepareCompactedHistory(deps, {
          userId,
          conversationId,
          messageId: history.messageId,
          modelId,
          // The model's real window, not the artificial one.
          contextLength: 128_000,
          existingCheckpoint: null,
          messages: history.messages,
          renderedMessages: history.renderedMessages,
          fixedPrefix: [],
          webToolsEnabled: false,
        });
        return { decision, summarized: generateText.mock.calls.length };
      }),
    );
    expect(result.decision.mode).toBe("full");
    expect(result.decision.startIndex).toBe(0);
    expect(result.decision.injectedMessages).toHaveLength(0);
    expect(result.summarized).toBe(0);
  });

  it("keeps a user-led tail within the hard input budget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 10);
        const { decision, history } = yield* prepare({ userId, conversationId });
        return { decision, firstRole: history.messages[decision.startIndex]?.role };
      }),
    );
    expect(result.firstRole).toBe("user");
    expect(result.decision.estimatedInputTokens).toBeLessThanOrEqual(result.decision.budget.input);
  });
});

/** Runs one generation to completion; `subscribe` ends at a terminal status. */
const generate = Effect.fn("test.generate")(function* (input: {
  userId: string;
  conversationId: string;
  messageId: string;
  modelId: string;
  searchEnabled?: boolean;
  timeZone?: string;
}) {
  const engine = yield* StreamEngine;
  const { searchEnabled = false, ...generation } = input;
  const repo = yield* ChatRepo;
  const message = yield* repo.getMessage(input.messageId);
  yield* engine.startGeneration({
    ...generation,
    searchEnabled,
    generationId: message?.generationId ?? undefined,
  });
  yield* engine.subscribe(input.messageId, 0).pipe(Stream.runDrain);
});

describe("question history compaction", () => {
  beforeEach(() => gateway.reset());

  it.each(["summary", "summary failure", "provider overflow"] as const)(
    "retains tool-only questions with the immediate answer through %s",
    async (mode) => {
      gateway.summaryFails = mode === "summary failure";
      gateway.overflowsLeft = mode === "provider overflow" ? 1 : 0;
      gateway.reportedInputTokens = 1000;
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const userId = yield* makeUser();
          const conversationId = yield* seedConversation(userId, 8);
          const asking = yield* repo.createTurn({
            userId,
            conversationId,
            modelId: smallModelId,
            content: "Help me choose an approach.",
            attachmentIds: [],
          });
          yield* repo.finalizeMessage({
            messageId: asking.assistant.id,
            status: "complete",
            content: "",
          });
          const params = {
            questions: [
              {
                question: "Which unique clarification should be preserved?",
                options: [{ label: "First approach" }, { label: "Second approach" }],
                multiSelect: false,
              },
            ],
          };
          const callId = uuidv7();
          yield* repo.insertToolCall({
            id: callId,
            messageId: asking.assistant.id,
            turnIndex: 0,
            callIndex: 0,
            providerCallId: "ask",
            toolName: "ask_user",
            arguments: params,
          });
          yield* repo.completeToolCall({
            id: callId,
            status: "complete",
            result: { v: 1, outcome: "presented", ...params },
          });
          const reply = yield* repo.createTurn({
            userId,
            conversationId,
            modelId: smallModelId,
            attachmentIds: [],
            questionResponse: {
              callId,
              response: { kind: "answers", answers: [{ selected: [1], custom: "" }] },
            },
          });
          yield* generate({
            userId,
            conversationId,
            messageId: reply.assistant.id,
            modelId: smallModelId,
          });
          return {
            final: yield* repo.getMessage(reply.assistant.id),
            original: yield* repo.getMessage(asking.assistant.id),
          };
        }),
      );
      expect(result.final?.status).toBe("complete");
      expect(result.original?.content).toBe("");
      expect(gateway.summaryPrompts.length).toBeGreaterThan(0);
      expect(gateway.summaryPrompts.join("\n")).not.toContain("Which unique clarification");
      expect(gateway.streamPrompts.length).toBe(mode === "provider overflow" ? 2 : 1);
      for (const prompt of gateway.streamPrompts) {
        expect(prompt).toContain("Which unique clarification should be preserved?");
        expect(prompt).toContain("Q1: Second approach");
        expect(prompt.indexOf("Which unique clarification")).toBeLessThan(
          prompt.indexOf("Q1: Second approach"),
        );
      }
    },
  );
});

/** A fresh turn on an already-long conversation, ready to be generated into. */
const askAgain = Effect.fn("test.askAgain")(function* (userId: string, conversationId: string) {
  const repo = yield* ChatRepo;
  const turn = yield* repo.createTurn({
    userId,
    conversationId,
    modelId: smallModelId,
    content: `question latest ${"z".repeat(2000)}`,
    attachmentIds: [],
  });
  return turn.assistant.id;
});

const attachDocument = Effect.fn("test.attachDocument")(function* (
  userId: string,
  messageId: string,
  mediaType: "text/plain" | "application/pdf",
) {
  const db = yield* Db;
  const blobId = uuidv7();
  const attachmentId = uuidv7();
  const storageKey = `test/${blobId}`;
  yield* db.insert(attachmentBlobs).values({
    id: blobId,
    userId,
    sha256: blobId,
    storageKey,
    size: 4,
    mediaType,
  });
  yield* db.insert(attachments).values({
    id: attachmentId,
    userId,
    blobId,
    fileName: mediaType === "application/pdf" ? "document.pdf" : "document.txt",
  });
  yield* db.insert(messageAttachments).values({ messageId, attachmentId, position: 0 });
  return storageKey;
});

const runtimeBlock = (serialized: string) => {
  const { content } = JSON.parse(serialized) as {
    content: Array<{ role: string; content: unknown }>;
  };
  const matches = content.filter((message) =>
    JSON.stringify(message.content).includes("<runtime-context>"),
  );
  expect(matches).toHaveLength(1);
  const message = matches[0]!;
  expect(message.role).toBe("user");
  expect(JSON.stringify(content.filter((entry) => entry.role === "system"))).not.toContain(
    "<runtime-context>",
  );
  return { message, index: content.indexOf(message), content };
};

describe("compaction inside a generation", () => {
  beforeEach(() => {
    gateway.reset();
    getBlob.mockReset();
    parsePdf.mockReset();
    parserAvailability.mockClear();
    readerHandler.mockClear();
  });

  it.each(["missing", "throwing"] as const)(
    "never reads a covered %s PDF blob or consults its parser",
    async (failure) => {
      if (failure === "throwing")
        getBlob.mockImplementation(() => Effect.die("blob read exploded"));
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const userId = yield* makeUser();
          const conversationId = yield* seedConversation(userId, 2);
          const history = yield* historyOf(conversationId);
          yield* attachDocument(userId, history.messages[0]!.id, "application/pdf");
          yield* repo.insertCompactionCheckpoint({
            conversationId,
            throughMessageId: history.messages[1]!.id,
            modelId,
            summary: "COVERED DOCUMENT SUMMARY",
          });
          const messageId = yield* askAgain(userId, conversationId);
          yield* generate({ userId, conversationId, messageId, modelId });
          return yield* repo.getMessage(messageId);
        }),
      );
      expect(result?.status).toBe("complete");
      expect(getBlob).not.toHaveBeenCalled();
      expect(parserAvailability).not.toHaveBeenCalled();
      expect(parsePdf).not.toHaveBeenCalled();
      expect(gateway.summaryPrompts).toEqual([]);
      expect(gateway.streamPrompts[0]).toContain("COVERED DOCUMENT SUMMARY");
      expect(gateway.streamPrompts[0]).not.toContain("question 0 ");
      expect(gateway.streamPrompts[0]).toContain("question 1 ");
      expect(gateway.streamPrompts[0]).toContain("question latest");
    },
  );

  it.each([
    { checkpoint: false, failure: false },
    { checkpoint: true, failure: false },
    { checkpoint: false, failure: true },
    { checkpoint: true, failure: true },
  ])(
    "still resolves uncovered attachments ($checkpoint checkpoint, $failure failure)",
    async ({ checkpoint, failure }) => {
      if (!failure)
        getBlob.mockImplementation(() =>
          Effect.succeed(new TextEncoder().encode("UNCOVERED DOCUMENT")),
        );
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const userId = yield* makeUser();
          const conversationId = yield* seedConversation(userId, 2);
          const history = yield* historyOf(conversationId);
          if (checkpoint)
            yield* repo.insertCompactionCheckpoint({
              conversationId,
              throughMessageId: history.messages[1]!.id,
              modelId,
              summary: "COVERED PREFIX",
            });
          const storageKey = yield* attachDocument(userId, history.messages[2]!.id, "text/plain");
          const messageId = yield* askAgain(userId, conversationId);
          yield* generate({ userId, conversationId, messageId, modelId });
          return { message: yield* repo.getMessage(messageId), storageKey };
        }),
      );
      expect(getBlob).toHaveBeenCalledExactlyOnceWith(result.storageKey);
      expect(result.message?.status).toBe(failure ? "error" : "complete");
      if (failure) {
        expect(result.message?.error).toMatchObject({ tag: "GenerationFailed" });
        expect(gateway.streamPrompts).toEqual([]);
      } else {
        expect(gateway.streamPrompts[0]).toContain("UNCOVERED DOCUMENT");
        expect(gateway.streamPrompts[0]).toContain("question 1 ");
      }
    },
  );

  it("retains uncovered PDF parse failures inside generation error handling", async () => {
    getBlob.mockImplementation(() => Effect.succeed(new Uint8Array([1, 2, 3, 4])));
    parsePdf.mockImplementation(({ fileName }) =>
      Effect.fail(
        new DocumentParseError({
          fileName,
          reason: "cannot parse uncovered PDF",
        }),
      ),
    );
    const message = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 2);
        const history = yield* historyOf(conversationId);
        yield* repo.insertCompactionCheckpoint({
          conversationId,
          throughMessageId: history.messages[1]!.id,
          modelId,
          summary: "COVERED PREFIX",
        });
        yield* attachDocument(userId, history.messages[2]!.id, "application/pdf");
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId });
        return yield* repo.getMessage(messageId);
      }),
    );
    expect(getBlob).toHaveBeenCalledOnce();
    expect(parserAvailability).toHaveBeenCalledOnce();
    expect(parsePdf).toHaveBeenCalledOnce();
    expect(message?.status).toBe("error");
    expect(message?.error).toMatchObject({ tag: "GenerationFailed" });
    expect(gateway.streamPrompts).toEqual([]);
  });

  it("keeps covered user URLs and persisted sources in reader authority and citation numbering", async () => {
    const userUrl = "https://example.com/user-document";
    const sourceUrl = "https://example.com/prior-source";
    const inventedUrl = "https://example.com/assistant-only";
    await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId: smallModelId,
          content: `Read ${userUrl}`,
          attachmentIds: [],
        });
        yield* repo.finalizeMessage({
          messageId: turn.assistant.id,
          status: "complete",
          content: `See ${inventedUrl}`,
        });
        const callId = uuidv7();
        yield* repo.insertToolCall({
          id: callId,
          messageId: turn.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "old-search",
          toolName: "web_search",
          arguments: { queries: ["old query"] },
        });
        yield* repo.completeToolCall({
          id: callId,
          status: "complete",
          result: {
            ok: true,
            targets: ["old query"],
            resultCount: 1,
            pagesFetched: 0,
            failures: [],
            sources: [
              {
                kind: "web" as const,
                index: 7,
                url: sourceUrl,
                title: "Prior source",
                read: false,
              },
            ],
          },
        });
        const conversationId = turn.conversation.id;
        yield* repo.insertCompactionCheckpoint({
          conversationId,
          throughMessageId: turn.assistant.id,
          modelId: smallModelId,
          summary: "Earlier documents discussed, without their URLs",
        });
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        expect((yield* repo.getMessage(messageId))?.status).toBe("complete");
      }),
    );
    // Search is off and the verbatim suffix has no URLs. The covered metadata
    // must still arm the reader and seed the shared application-owned state.
    expect(readerHandler).toHaveBeenCalledOnce();
    const [indexer, authority] = readerHandler.mock.calls[0]!;
    expect(authority.resolve(userUrl)).toBe(userUrl);
    expect(authority.resolve(sourceUrl)).toBe(sourceUrl);
    expect(authority.resolve(inventedUrl)).toBeNull();
    expect(indexer.indexFor(sourceUrl)).toBe(7);
    expect(indexer.indexFor("https://example.com/new-source")).toBe(8);
    expect(gateway.streamPrompts[0]).not.toContain(userUrl);
    expect(gateway.streamPrompts[0]).not.toContain(inventedUrl);
  });

  it("recovers overflow using suffix-local metadata after a nonzero checkpoint", async () => {
    gateway.overflowsLeft = 1;
    const message = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 4);
        const history = yield* historyOf(conversationId);
        yield* repo.insertCompactionCheckpoint({
          conversationId,
          throughMessageId: history.messages[3]!.id,
          modelId,
          summary: "EARLIER CHECKPOINT",
        });
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId });
        return yield* repo.getMessage(messageId);
      }),
    );
    expect(message?.status).toBe("complete");
    expect(gateway.summaryPrompts).toEqual([]);
    expect(gateway.streamPrompts).toHaveLength(2);
    expect(gateway.streamPrompts[0]).toContain("EARLIER CHECKPOINT");
    expect(gateway.streamPrompts[0]).toContain("question 2 ");
    expect(gateway.streamPrompts[1]).not.toContain("question 2 ");
    expect(gateway.streamPrompts[1]).toContain("question latest");
    expect(gateway.streamPrompts[1]).toContain("<context-truncation-notice>");
    expect(runtimeBlock(gateway.streamPrompts[0]!).message).toEqual(
      runtimeBlock(gateway.streamPrompts[1]!).message,
    );
  });

  it("summarizes before the answer streams and sends summary + tail, not the whole log", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const before = yield* historyOf(conversationId);
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        return {
          message: yield* repo.getMessage(messageId),
          checkpoints: yield* checkpointsOf(conversationId),
          chunks: yield* repo.chunksAfter(messageId, 0),
          events: yield* repo.listCompactionEvents([messageId]),
          storedBefore: before.messages.length,
          storedAfter: (yield* historyOf(conversationId)).messages.length,
        };
      }),
    );

    // The summary was written first, and only then was the answer requested.
    expect(gateway.summaryPrompts).toHaveLength(1);
    expect(gateway.streamPrompts).toHaveLength(1);
    expect(result.checkpoints).toHaveLength(1);

    const prompt = gateway.streamPrompts[0]!;
    expect(prompt).toContain("SUMMARY OF EARLIER TURNS");
    expect(prompt).toContain("question latest");
    const clock = runtimeBlock(prompt);
    expect(clock.index).toBe(clock.content.length - 1);
    expect(JSON.stringify(clock.content[clock.index - 1])).toContain("question latest");
    expect(JSON.stringify(clock.message)).toContain("Time zone: UTC");
    expect(gateway.summaryPrompts[0]).not.toContain("<runtime-context>");
    expect(JSON.stringify(result.checkpoints)).not.toContain("<runtime-context>");
    const messages = clock.content as ReadonlyArray<Prompt.MessageEncoded>;
    expect(result.message?.usage?.estimatedFirstInputTokens).toBe(estimatePromptTokens(messages));
    expect(estimatePromptTokens(messages)).toBeGreaterThan(
      estimatePromptTokens(messages.slice(0, -1)),
    );
    // The oldest turn is represented by the summary, not by its own text.
    expect(prompt).not.toContain("question 0 ");
    expect(result.message?.status).toBe("complete");
    expect(result.message?.content).toBe("answered");
    // Two rows added by the new turn; nothing removed to make room.
    expect(result.storedAfter).toBe(result.storedBefore + 2);

    // The pass is dead air on the client, so it is announced as chunks. The
    // chunks are persisted, so a reload mid-pass replays it like any other marker.
    const markers = result.chunks
      .filter((chunk) => chunk.kind === "compaction")
      .map((chunk) => JSON.parse(chunk.delta) as Record<string, unknown>);
    expect(markers[0]).toMatchObject({
      v: 1,
      phase: "start",
      beforeTurnIndex: 0,
      passIndex: 0,
      textOffset: 0,
      scope: "history",
    });
    expect(markers[1]).toMatchObject({
      v: 1,
      phase: "result",
      eventId: markers[0]?.eventId,
      beforeTurnIndex: 0,
      passIndex: 0,
      textOffset: 0,
      scope: "history",
      ok: true,
      outcome: "summary",
    });
    expect(markers[1]?.summary).toBe(result.checkpoints[0]?.summary);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: markers[0]?.eventId,
      textOffset: 0,
      status: "complete",
      outcome: "summary",
      checkpointId: result.checkpoints[0]?.id,
    });
    // Ahead of the answer's first token, which is the whole point.
    expect(result.chunks[0]?.kind).toBe("compaction");
    expect(result.chunks.at(-1)?.kind).toBe("text");
  }, 60_000);

  it("summarizes a complete tool round before the continuation call", async () => {
    const rawSentinel = `RAW_PAGE_BODY_SENTINEL_${"r".repeat(20_000)}`;
    gateway.toolRoundResult = rawSentinel;
    gateway.summary = "ACTIVE ROUND SUMMARY";

    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId: toolModelId,
          content: "Find the current source.",
          attachmentIds: [],
        });
        yield* generate({
          userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          modelId: toolModelId,
          searchEnabled: true,
        });

        return {
          message: yield* repo.getMessage(turn.assistant.id),
          chunks: yield* repo.chunksAfter(turn.assistant.id, 0),
          events: yield* repo.listCompactionEvents([turn.assistant.id]),
          toolCalls: yield* repo.listToolCalls([turn.assistant.id]),
        };
      }),
    );

    expect(gateway.streamPrompts).toHaveLength(2);
    expect(gateway.summaryPrompts).toHaveLength(1);
    expect(gateway.summaryPrompts[0]).toContain("RAW_PAGE_BODY_SENTINEL_");
    expect(gateway.summaryPrompts[0]).toContain(TOOL_SOURCE_URL);

    const continuation = gateway.streamPrompts[1]!;
    expect(continuation).toContain("ACTIVE ROUND SUMMARY");
    expect(continuation).not.toContain("RAW_PAGE_BODY_SENTINEL_");
    const initialClock = runtimeBlock(gateway.streamPrompts[0]!);
    const continuedClock = runtimeBlock(continuation);
    expect(continuedClock.message).toEqual(initialClock.message);
    expect(continuedClock.index).toBe(initialClock.index);
    expect(continuedClock.content.slice(0, continuedClock.index + 1)).toEqual(
      initialClock.content.slice(0, initialClock.index + 1),
    );
    expect(JSON.stringify(continuedClock.content.slice(continuedClock.index + 1))).toContain(
      "ACTIVE ROUND SUMMARY",
    );
    expect(gateway.summaryPrompts[0]).not.toContain("<runtime-context>");
    // Source authority and citation numbering come from application state, not
    // from the generated summary that replaced the raw tool transcript.
    expect(continuation).toContain(TOOL_SOURCE_URL);
    expect(continuation).toContain("[^1]");

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      beforeTurnIndex: 1,
      passIndex: 0,
      textOffset: 0,
      scope: "active_rounds",
      status: "complete",
      outcome: "summary",
      summary: "ACTIVE ROUND SUMMARY",
      checkpointId: null,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.stringify(result.toolCalls[0]?.result)).not.toContain("RAW_PAGE_BODY_SENTINEL_");
    expect(result.message).toMatchObject({ status: "complete", content: "answered" });

    const activity = result.chunks.filter(
      (chunk) => chunk.kind === "tool" || chunk.kind === "compaction",
    );
    expect(activity.map((chunk) => chunk.kind)).toEqual([
      "tool",
      "tool",
      "compaction",
      "compaction",
    ]);
    expect(
      activity
        .filter((chunk) => chunk.kind === "tool")
        .map((chunk) => JSON.parse(chunk.delta).phase),
    ).toEqual(["start", "result"]);
    expect(JSON.stringify(result.chunks)).not.toContain("RAW_PAGE_BODY_SENTINEL_");
  }, 60_000);

  it("recovers an untouched later-round overflow without rerunning the tool", async () => {
    gateway.toolRoundResult = "LATER_OVERFLOW_RAW_RESULT";
    gateway.summary = "LATER OVERFLOW SUMMARY";
    gateway.reportedInputTokens = 100;
    gateway.overflowOnCalls = [2];

    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId: toolModelId,
          content: "Find the current source.",
          attachmentIds: [],
        });
        yield* generate({
          userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          modelId: toolModelId,
          searchEnabled: true,
        });
        return {
          message: yield* repo.getMessage(turn.assistant.id),
          chunks: yield* repo.chunksAfter(turn.assistant.id, 0),
          events: yield* repo.listCompactionEvents([turn.assistant.id]),
        };
      }),
    );

    expect(gateway.streamPrompts).toHaveLength(3);
    expect(gateway.streamPrompts[1]).toContain("LATER_OVERFLOW_RAW_RESULT");
    expect(gateway.streamPrompts[2]).toContain("LATER OVERFLOW SUMMARY");
    expect(gateway.streamPrompts[2]).not.toContain("LATER_OVERFLOW_RAW_RESULT");
    expect(gateway.summaryPrompts).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      beforeTurnIndex: 1,
      scope: "active_rounds",
      status: "complete",
      outcome: "summary",
    });
    expect(
      result.chunks
        .filter((chunk) => chunk.kind === "tool")
        .map((chunk) => JSON.parse(chunk.delta).phase),
    ).toEqual(["start", "result"]);
    expect(result.message).toMatchObject({ status: "complete", content: "answered" });
  }, 60_000);

  it("does not retry a later-round overflow after output has started", async () => {
    gateway.toolRoundResult = "PARTIAL_OVERFLOW_RAW_RESULT";
    gateway.reportedInputTokens = 100;
    gateway.partialOverflowOnCalls = [2];

    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId: toolModelId,
          content: "Find the current source.",
          attachmentIds: [],
        });
        yield* generate({
          userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          modelId: toolModelId,
          searchEnabled: true,
        });
        return {
          message: yield* repo.getMessage(turn.assistant.id),
          chunks: yield* repo.chunksAfter(turn.assistant.id, 0),
          events: yield* repo.listCompactionEvents([turn.assistant.id]),
        };
      }),
    );

    expect(gateway.streamPrompts).toHaveLength(2);
    expect(gateway.summaryPrompts).toHaveLength(0);
    expect(result.events).toHaveLength(0);
    expect(
      result.chunks
        .filter((chunk) => chunk.kind === "tool")
        .map((chunk) => JSON.parse(chunk.delta).phase),
    ).toEqual(["start", "result"]);
    expect(result.message).toMatchObject({ status: "error", content: "partial" });
  }, 60_000);

  it("persists the calibration pair so the next estimate can be corrected", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        return (yield* repo.getMessage(messageId))?.usage;
      }),
    );
    // What the provider counted for the first call, beside what we predicted
    // for that same prompt, since either alone calibrates nothing.
    expect(usage?.firstInputTokens).toBe(9_999);
    expect(usage?.estimatedFirstInputTokens).toBeGreaterThan(0);
  }, 60_000);

  it("retries a refused prompt once, with fewer turns", async () => {
    gateway.overflowsLeft = 1;
    const message = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        return yield* repo.getMessage(messageId);
      }),
    );

    expect(gateway.streamPrompts).toHaveLength(2);
    // The retry is strictly smaller, since resending the rejected prompt would
    // just be refused again.
    expect(gateway.streamPrompts[1]!.length).toBeLessThan(gateway.streamPrompts[0]!.length);
    // The newest question survives the shrink; it is the one being answered.
    expect(gateway.streamPrompts[1]!).toContain("question latest");
    expect(message?.status).toBe("complete");
    expect(message?.content).toBe("answered");
  }, 60_000);

  it("gives up after the second refusal instead of shrinking forever", async () => {
    gateway.overflowsLeft = 2;
    const message = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        return yield* repo.getMessage(messageId);
      }),
    );
    expect(gateway.streamPrompts).toHaveLength(2);
    expect(message?.status).toBe("error");
  }, 60_000);

  it("still answers when the model cannot write a summary", async () => {
    gateway.summaryFails = true;
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* seedConversation(userId, 8);
        const messageId = yield* askAgain(userId, conversationId);
        yield* generate({ userId, conversationId, messageId, modelId: smallModelId });
        return {
          message: yield* repo.getMessage(messageId),
          checkpoints: yield* checkpointsOf(conversationId),
          ledger: yield* db
            .select({ kind: usageEvents.kind, status: usageEvents.status })
            .from(usageEvents)
            .where(eq(usageEvents.conversationId, conversationId)),
        };
      }),
    );

    // Truncated rather than summarized, but the user still gets an answer.
    expect(result.checkpoints).toHaveLength(0);
    expect(result.message?.status).toBe("complete");
    expect(result.message?.content).toBe("answered");
    expect(gateway.streamPrompts[0]!).toContain("question latest");
    expect(result.ledger).toContainEqual({ kind: "compaction", status: "error" });
    expect(result.ledger).toContainEqual({ kind: "chat", status: "complete" });
  }, 60_000);
});
