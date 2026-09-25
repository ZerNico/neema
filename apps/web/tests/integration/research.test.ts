import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Duration, Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response, type Prompt } from "effect/unstable/ai";
import { and, asc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  messages,
  messageChunks,
  messageToolCalls,
  models,
  researchCalls,
  researchRuns,
  researchTasks,
  usageEvents,
} from "~/db/schema/index.ts";
import { RESEARCH_LIMITS, researchOutputCaps } from "~/modules/chat/server/research/budget.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { computeBudget, estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import {
  projectResearchProgress,
  type ResearchPhase,
  type ResearchTaskProgress,
} from "~/modules/chat/research-schema.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { loadConversationDetail } from "~/modules/chat/server/conversation-detail.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import {
  AiGateway,
  ProviderContextOverflow,
  ProviderUnreachable,
  type ChatStreamPart,
} from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { SearchBackend, SearchBackendError } from "~/modules/tools/server/search.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import {
  FakeBlobStore,
  FakeDocumentParser,
  FakeCustomToolRuntime,
  NoIntegrations,
} from "./unused-services.ts";
import { MemoryRepo } from "~/modules/memory/server/repo.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

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

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  | ChatRepo
  | ChatService
  | StreamEngine
  | Db
  | ToolsRepo
  | MemoryService
  | AgentRepo
  | AgentDraftService
  | AttachmentRepo
  | ScheduleRepo,
  unknown
>;
let remote: typeof runtime;
let modelId: string;
type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];
/**
 * Shape of the `progress` field inside a decoded `message_tool_calls.result`
 * blob for a `deep_research` call. `result` is a `JsonValue`, an index-signature
 * type that never overlaps with a named-property interface, so the cast goes
 * through the blob's `Record<string, unknown>` shape first and this shape is
 * applied to the `.progress` property access instead.
 */
interface StoredResearchProgress {
  readonly runId: string;
  readonly phase: ResearchPhase;
  readonly tasks: Array<{
    readonly id: string;
    readonly ordinal: number;
    readonly title: string;
    readonly status: ResearchTaskProgress["status"];
    readonly error?: string;
  }>;
  readonly limitations: Array<string>;
  readonly usageComplete: boolean;
}
const requests: GatewayInput[] = [];
let coordinatorFailure: "provider" | "context" | "defect" | null = null;
let coordinatorFirstResponse: "finish" | "text" | "empty" | null = null;
let evidenceUrl = "https://evidence.example/source";
let overflowPhase: string | null = null;
let dispatchWaves = 1;
let coordinatorTurns = 0;
let queriesPerSearch = 1;
let searchDown = false;
let finishWorkersEarly = false;
/** How many `deep_research` calls the host makes before answering from them. */
let hostPlan: 0 | 1 | 2 = 1;
let hostBrief = "Find out whether the claim holds, and what evidence would settle it.";
/** The host asks one question before it is willing to write a brief. */
let hostAsksFirst = false;
let hostAsks = 0;
/** The host also opens a page in the same turn, so a sibling call is in flight. */
let hostReadsAlongside = false;
let hostDraft = false;
let hostDraftTurns = 0;
const HOLD_URL = "https://hold.example/wait";
let readerGate: {
  reached: Deferred.Deferred<void>;
  release: Deferred.Deferred<void>;
} | null = null;
let reportRepeats = 1;
let reportSuffix = "";
let reportFinishReason: "stop" | "length" = "stop";
let compactionFails = false;
// Searches within a run are cached by query, so every fake call must ask
// something new for the budget tests to reach the ceiling.
let searchCalls = 0;
// Count only actual backend executions, not tool calls or their requested batch sizes.
let backendSearches = 0;
let hold: {
  phase: string;
  reached: Deferred.Deferred<void>;
  interrupted: Deferred.Deferred<void>;
  release?: Deferred.Deferred<void>;
} | null = null;
/** The draft the tools last wrote, as the trailing application data reports it. */
const focusedDraftId = (input: GatewayInput) => {
  const block = input.prompt.content
    .flatMap((message) => {
      const content: unknown = message.content;
      return typeof content === "string"
        ? [content]
        : (content as Array<{ text?: string }>).map((part) => part.text ?? "");
    })
    .find((text) => text.startsWith("Application-provided agent draft"));
  return (
    (
      JSON.parse(block!.slice(block!.indexOf("\n") + 1)) as {
        draft: { draftId: string } | null;
      }
    ).draft?.draftId ?? ""
  );
};
/**
 * Research stages are told apart by the toolkit they were handed, never by the
 * conversation: the host is the only turn that can ask the user anything.
 */
const phaseOf = (input: GatewayInput) => {
  const content = input.prompt.content.map((message) => JSON.stringify(message)).join("\n");
  if (content.includes("You compact the older part of a chat conversation")) return "compaction";
  if (input.toolkit?.tools["dispatch_research"]) return "coordinator";
  if (input.toolkit?.tools["web_search"] && !input.toolkit.tools["ask_user"]) return "worker";
  if (content.includes("Write a concise, evidence-dense report")) return "report";
  return "host";
};
const finish = (reason = "stop") =>
  Response.makePart("finish", {
    reason: reason as "stop",
    usage: new Response.Usage({
      inputTokens: { total: 100, uncached: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    }),
  }) as ChatStreamPart;
const text = (delta: string) =>
  Response.makePart("text-delta", { id: "text", delta }) as ChatStreamPart;
const resultsOf = (input: GatewayInput, name: string, params: unknown, id: string) =>
  Stream.unwrap(input.toolkit!.handle(name, params, id).pipe(Effect.orDie)).pipe(
    Stream.orDie,
    Stream.map(
      (value) =>
        Response.toolResultPart({ id, name, providerExecuted: false, ...value }) as ChatStreamPart,
    ),
  ) as Stream.Stream<ChatStreamPart>;
const tool = (input: GatewayInput, name: string, params: unknown) => {
  const id = "same-provider-id"; // deliberately repeated in concurrent workers and all invocations
  return Stream.make(
    Response.makePart("tool-call", { id, name, params, providerExecuted: false }) as ChatStreamPart,
  ).pipe(
    Stream.concat(resultsOf(input, name, params, id)),
    Stream.concat(Stream.make(finish("tool-calls"))),
  );
};
/** Two calls published before either handler runs, the shape a real turn takes. */
const twoTools = (
  input: GatewayInput,
  calls: readonly [
    { name: string; params: unknown; id: string },
    { name: string; params: unknown; id: string },
  ],
) =>
  Stream.fromIterable(
    calls.map(
      (call) =>
        Response.makePart("tool-call", {
          id: call.id,
          name: call.name,
          params: call.params,
          providerExecuted: false,
        }) as ChatStreamPart,
    ),
  ).pipe(
    Stream.concat(
      resultsOf(input, calls[0].name, calls[0].params, calls[0].id).pipe(
        Stream.merge(resultsOf(input, calls[1].name, calls[1].params, calls[1].id)),
      ),
    ),
    Stream.concat(Stream.make(finish("tool-calls"))),
  );
const streamChat: AiGateway["Service"]["streamChat"] = (input) =>
  Stream.suspend((): ReturnType<AiGateway["Service"]["streamChat"]> => {
    requests.push(input);
    const phase = phaseOf(input);
    if (overflowPhase === phase) {
      overflowPhase = null;
      return Stream.fail(
        new ProviderContextOverflow({ providerId: "fake", message: "context length exceeded" }),
      );
    }
    if (hold?.phase === phase) {
      const gate = hold;
      return Stream.fromEffect(
        Deferred.succeed(gate.reached, undefined).pipe(
          Effect.andThen(gate.release ? Deferred.await(gate.release) : Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(gate.interrupted, undefined)),
          Effect.as(text("Held stage resumed.")),
        ),
      ).pipe(Stream.concat(Stream.make(finish())));
    }
    if (phase === "host") {
      // Counted rather than read back from the prompt: the next turn renders
      // the question as prose, not as the tool name.
      if (hostAsksFirst && hostAsks++ === 0)
        return tool(input, "ask_user", {
          questions: [
            {
              question: "Which region?",
              options: [{ label: "Europe" }, { label: "Asia" }],
              multiSelect: false,
            },
          ],
        });
      if (hostDraft && hostDraftTurns++ > 0)
        return hostDraftTurns === 2
          ? Stream.make(text("I found useful guidance for the draft.\n")).pipe(
              Stream.concat(
                tool(input, "draft_agent", {
                  changes: { name: "Research agent", instructions: "PRIVATE_INITIAL_DRAFT" },
                }),
              ),
            )
          : hostDraftTurns === 3
            ? tool(input, "update_agent_draft", {
                // Named explicitly: a chat may already hold another draft, and
                // an unaddressed update is ambiguous then.
                draftId: focusedDraftId(input),
                expectedRevision: 1,
                changes: { instructions: "PRIVATE_RESEARCH_DRAFT" },
              })
            : Stream.make(text("# Findings\nSupported conclusion[^1].\n"), finish());
      const madeCalls = input.prompt.content.filter(
        (message) =>
          message.role === "assistant" && JSON.stringify(message).includes("deep_research"),
      ).length;
      if (input.toolkit?.tools["deep_research"] && madeCalls < hostPlan) {
        const research = {
          name: "deep_research",
          params: { brief: hostBrief },
          id: "host-research",
        };
        return hostReadsAlongside
          ? twoTools(input, [
              research,
              { name: "read_url", params: { urls: [HOLD_URL] }, id: "host-read" },
            ])
          : tool(input, research.name, research.params);
      }
      return Stream.make(
        text("# Findings\nSupported conclusion[^1].\n"),
        text("Coverage remains limited where sources disagreed.\n"),
        finish(),
      );
    }
    if (phase === "compaction")
      return compactionFails
        ? Stream.fail(
            new ProviderUnreachable({ providerId: "fake", message: "summary unavailable" }),
          )
        : Stream.make(
            text(
              "The tasks found supporting evidence[^1]; disagreements remain unresolved. https://evidence.example/source",
            ),
            finish(),
          );
    if (phase === "coordinator") {
      const message = "PRIVATE_PROVIDER_PAYLOAD authorization=secret request body";
      if (coordinatorFailure === "provider")
        return Stream.fail(
          new ProviderUnreachable({
            providerId: "fake",
            message,
            diagnostic: { kind: "InvalidRequestError", status: 400 },
          }),
        );
      if (coordinatorFailure === "context")
        return Stream.fail(new ProviderContextOverflow({ providerId: "fake", message }));
      if (coordinatorFailure === "defect") return Stream.die(new Error(message));
      if (coordinatorTurns === 0 && coordinatorFirstResponse) {
        coordinatorTurns++;
        if (coordinatorFirstResponse === "finish") return tool(input, "finish_research", {});
        if (coordinatorFirstResponse === "text")
          return Stream.make(text("No investigation is needed for this question."), finish());
        return Stream.make(finish());
      }
      return ++coordinatorTurns <= dispatchWaves
        ? tool(input, "dispatch_research", {
            tasks: [
              {
                title: "Evidence A",
                assignment: "Investigate evidence for the user's question from primary sources.",
              },
              {
                title: "Evidence B",
                assignment: "Independently investigate disagreements and limitations.",
              },
            ],
          })
        : tool(input, "finish_research", {});
    }
    if (phase === "worker") {
      if (finishWorkersEarly && input.prompt.content.some((message) => message.role === "tool"))
        return Stream.make(finish());
      const call = ++searchCalls;
      return tool(input, "web_search", {
        queries: Array.from({ length: queriesPerSearch }, (_, i) => `shared evidence ${call}-${i}`),
      });
    }
    return Stream.make(
      text(
        "A bounded finding supported by shared evidence[^1].".repeat(reportRepeats) + reportSuffix,
      ),
      finish(reportFinishReason),
    );
  });
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
  // The real gateway folds its own stream, so a side generation goes through
  // exactly the same scripted turn as everything else here.
  generateText: (input) =>
    Stream.runFold(
      streamChat(input),
      () => ({ text: "", usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }) }),
      (state: { text: string; usage: Response.Usage }, part) =>
        part.type === "text-delta"
          ? { ...state, text: state.text + part.delta }
          : part.type === "finish"
            ? { ...state, usage: part.usage }
            : state,
    ).pipe(Effect.map((state) => ({ ...state, finishMetadata: {} }))),
  streamChat,
});
// Exercise the real config, handler and budget admission; only upstream search is fake.
const FakeSearchBackend = Layer.succeed(SearchBackend, {
  kind: "fake",
  search: () =>
    Effect.suspend(() => {
      backendSearches++;
      return searchDown
        ? Effect.fail(
            new SearchBackendError({
              backend: "fake",
              message: "search engines unavailable (too many requests)",
            }),
          )
        : Effect.succeed([{ url: evidenceUrl, title: "Evidence", snippet: "A supported finding" }]);
    }),
  test: () => Effect.succeed({ resultCount: 1 }),
});
const FakeReader = Layer.succeed(UrlReaderExecutor, {
  availability: () => Effect.succeed({ configured: true, enabled: true }),
  handler: () =>
    Effect.succeed((params: { urls?: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        // The host's own page read, held open so a sibling call is still
        // running while the research run beside it ends.
        if (readerGate && params.urls?.includes(HOLD_URL)) {
          yield* Deferred.succeed(readerGate.reached, undefined);
          yield* Deferred.await(readerGate.release);
        }
        return {
          ok: true,
          targets: [...(params.urls ?? [])],
          resultCount: 0,
          pagesFetched: 0,
          results: [],
          failures: [],
        };
      }),
    ) as never,
});

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const repos = Layer.mergeAll(
    AnalyticsRepo.layer,
    CustomToolRepo.layer,
    IntegrationRepo.layer,
    AgentRepo.layer,
    ScheduleRepo.layer,
    ChatRepo.layer,
    KnowledgeRepo.layer,
    MemoryRepo.layer,
    ProviderRepo.layer,
    ToolsRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infra),
  );
  const engine = StreamEngine.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGateway,
        FakeKnowledge,
        WebSearchExecutor.layer.pipe(Layer.provide(FakeSearchBackend)),
        FakeReader,
        FakeBlobStore,
        FakeDocumentParser,
        FakeCustomToolRuntime,
        NoIntegrations,
        MemoryService.layer.pipe(Layer.provide(SyncBus.layer)),
        ExternalCompletion.layer,
        SyncBus.layer,
        Layer.mergeAll(ScheduleDraftService.layer, AgentDraftService.layer).pipe(
          Layer.provideMerge(SyncBus.layer),
        ),
      ).pipe(Layer.provideMerge(repos)),
    ),
  );
  const app = ChatService.layer.pipe(
    Layer.provideMerge(AttachmentService.layer.pipe(Layer.provideMerge(engine))),
  );
  runtime = ManagedRuntime.make(app);
  remote = ManagedRuntime.make(app);
  modelId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const providerId = uuidv7();
      yield* db.execute(
        sql`insert into providers (id,name,kind,base_url,api_key_ciphertext) values (${providerId},'Test','openrouter','https://invalid.example','unused')`,
      );
      yield* db.insert(models).values({
        id: modelId,
        providerId,
        modelKey: "fake",
        displayName: "Fake Research",
        type: "chat",
        capabilities: { tools: true, reasoning: false, files: false, vision: false },
        contextLength: 128000,
        pricing: { input: 1, output: 2 },
      });
    }),
  );
}, 120000);
afterAll(async () => {
  await remote?.dispose();
  await runtime?.dispose();
  await database?.drop();
});
beforeEach(async () => {
  await runtime.runPromise(
    ToolsRepo.use((repo) =>
      repo.updateTool("web_search", {
        enabled: true,
        config: { researchMaxSearchQueries: RESEARCH_LIMITS.searches },
      }),
    ),
  );
  await runtime.runPromise(
    ToolsRepo.use((repo) => repo.updateTool("memory", { enabled: false, config: {} })),
  );
  requests.length = 0;
  evidenceUrl = "https://evidence.example/source";
  coordinatorFailure = null;
  coordinatorFirstResponse = null;
  overflowPhase = null;
  dispatchWaves = 1;
  coordinatorTurns = 0;
  queriesPerSearch = 1;
  searchCalls = 0;
  backendSearches = 0;
  searchDown = false;
  finishWorkersEarly = false;
  hostPlan = 1;
  hostBrief = "Find out whether the claim holds, and what evidence would settle it.";
  hostAsksFirst = false;
  hostAsks = 0;
  hostReadsAlongside = false;
  hostDraft = false;
  hostDraftTurns = 0;
  readerGate = null;
  reportRepeats = 1;
  reportSuffix = "";
  reportFinishReason = "stop";
  compactionFails = false;
  await runtime.runPromise(
    Db.use((db) => db.update(models).set({ contextLength: 128000 }).where(eq(models.id, modelId))),
  );
  hold = null;
});
const seed = Effect.gen(function* () {
  const db = yield* Db;
  const repo = yield* ChatRepo;
  const userId = uuidv7();
  yield* db.execute(
    sql`insert into "user" (id,name,email) values (${userId},'Research Test',${`${userId}@test.invalid`})`,
  );
  const conversation = yield* repo.createConversation({ userId, modelId });
  return { userId, conversationId: conversation.id };
});
const send = (
  userId: string,
  conversationId: string,
  content = "Investigate the evidence.",
  searchEnabled = false,
) =>
  Effect.flatMap(ChatService, (service) =>
    service.sendMessage({
      userId,
      conversation: { kind: "existing", id: conversationId },
      modelId,
      content,
      researchEnabled: true,
      searchEnabled,
      attachmentIds: [],
    }),
  );
const collect = (messageId: string, runId?: string) =>
  Effect.flatMap(StreamEngine, (engine) =>
    Stream.runCollect(engine.subscribe(messageId, 0, runId)),
  );
/**
 * A message no longer points at a run: the run points back, through the tool
 * call it answers. Tests that used to read `message.researchRunId` ask here.
 */
const runOf = (messageId: string) =>
  Effect.flatMap(Db, (db) =>
    db
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.messageId, messageId))
      .orderBy(asc(researchRuns.createdAt))
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.at(-1) ?? null),
      ),
  );
const runFor = (messageId: string) => runtime.runPromise(runOf(messageId));
const generationOf = async (messageId: string) => {
  const message = await runtime.runPromise(
    Effect.flatMap(ChatRepo, (repo) => repo.getMessage(messageId)),
  );
  return message!.generationId!;
};
/** Waits on the row itself: nothing signals when a run inside a turn ends. */
const awaitRunStatus = (messageId: string, status: "running" | "terminal") =>
  Effect.gen(function* () {
    for (;;) {
      const run = yield* runOf(messageId);
      if (run?.status === status) return run;
      yield* Effect.sleep(Duration.millis(5));
    }
  }).pipe(Effect.timeout(Duration.seconds(15)));
const enableMemory = (userId: string, referenceEnabled = true, autoSaveEnabled = true) =>
  runtime.runPromise(
    Effect.gen(function* () {
      yield* ToolsRepo.use((repo) => repo.updateTool("memory", { enabled: true, config: {} }));
      yield* MemoryService.use((service) =>
        service.updateSettings(userId, { referenceEnabled, autoSaveEnabled }),
      );
    }),
  );
const promptText = (input: GatewayInput) => JSON.stringify(input.prompt);
/** Provider calls the run paid for; the host's own turns are not its budget. */
const runRequests = () => requests.filter((request) => phaseOf(request) !== "host");

describe("deep research as a tool call", () => {
  it("answers from the evidence and leaves one terminal run under its own tool row", async () => {
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    const events = await runtime.runPromise(collect(sent.assistantMessageId));
    expect(events.at(-1)?.kind).toBe("done");
    const chunks = events.filter((event) => event.kind === "chunk");
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index + 1));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        // The host wrote the answer in its own turn, after the tool returned.
        expect(message.status).toBe("complete");
        expect(message.content).toContain("Supported conclusion[^1]");
        const persisted = yield* db
          .select()
          .from(messageChunks)
          .where(eq(messageChunks.messageId, message.id))
          .orderBy(messageChunks.seq);
        expect(
          chunks.map(({ seq, chunkKind, delta }) => ({ seq, kind: chunkKind, delta })),
        ).toEqual(persisted.map(({ seq, kind, delta }) => ({ seq, kind, delta })));
        const runs = yield* db
          .select()
          .from(researchRuns)
          .where(eq(researchRuns.messageId, message.id));
        expect(runs).toHaveLength(1);
        const run = runs[0]!;
        expect(run.status).toBe("terminal");
        // Fenced by the attempt that started it, owned by the call it answers.
        expect(run.generationId).toBe(message.generationId);
        expect(run.owner).toBeNull();
        const toolCalls = yield* repo.listToolCalls([message.id]);
        const root = toolCalls.find((call) => call.toolName === "deep_research")!;
        expect(run.toolCallId).toBe(root.id);
        expect(root.status).toBe("complete");
        expect(root.researchRunId).toBeNull();
        // Its own body, written by the run, survives the call being settled.
        expect((root.result as { progress?: { phase?: string } }).progress?.phase).toBe("complete");
        // Everything the investigation produced is marked as produced inside it.
        expect(
          toolCalls
            .filter((call) => call.toolName === "web_search")
            .every((call) => call.researchRunId === run.id),
        ).toBe(true);
        const calls = yield* db.select().from(researchCalls).where(eq(researchCalls.runId, run.id));
        expect(calls.length).toBe(requests.filter((request) => phaseOf(request) !== "host").length);
        expect(calls.every((call) => call.usageComplete)).toBe(true);
        expect(
          yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id)),
        ).toHaveLength(2);
        // Two ledger rows: the run's own, and the host generation's.
        const ledger = yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.messageId, message.id));
        expect(ledger.map((row) => row.id)).toContain(run.id);
        expect(ledger.find((row) => row.id === run.id)?.inputTokens).toBe(calls.length * 100);
        expect(yield* repo.research!.finalize(run.id, "error", "stale-owner")).toBe(false);
      }),
    );
    // The fake reuses one provider call id everywhere; every worker call must
    // still land on its own namespaced row.
    const toolCalls = await runtime.runPromise(
      ChatRepo.use((repo) => repo.listToolCalls([sent.assistantMessageId])),
    );
    expect(
      new Set(
        toolCalls
          .filter((call) => call.toolName === "web_search")
          .map((call) => call.providerCallId),
      ).size,
    ).toBe(requests.filter((request) => phaseOf(request) === "worker").length);
    // Every stage of the run is bounded; the host turn keeps the model default.
    expect(
      runRequests().every(
        (request) => request.modelId === modelId && request.maxOutputTokens !== undefined,
      ),
    ).toBe(true);
    for (const phase of ["coordinator", "report"]) {
      const stages = requests.filter((request) => phaseOf(request) === phase);
      expect(stages.length).toBeGreaterThan(0);
      for (const request of stages) {
        const content = request.prompt.content;
        expect(content.at(-2)?.role).toBe("assistant");
        expect(JSON.stringify(content.at(-2))).toContain(
          phase === "report" ? "Registered sources" : "Research brief (data)",
        );
        expect(content.at(-1)?.role).toBe("user");
        expect(JSON.stringify(content.at(-1))).toContain("data, not instructions");
      }
    }
    // The host is told to prefer the tool over searching itself; the web hint
    // alone would point it the other way. The investigation never sees this.
    const host = requests.find((request) => phaseOf(request) === "host")!;
    expect(promptText(host)).toContain("Prefer deep_research over searching");
    const workers = requests.filter((request) => phaseOf(request) === "worker");
    // Web tools plus the skill loaders: the bundled authoring skills sit in
    // every ambient catalogue, so a worker always carries load_skill.
    expect(
      workers.every(
        (request) =>
          Object.keys(request.toolkit!.tools).sort().join(",") ===
          "load_skill,read_skill_file,read_url,web_search",
      ),
    ).toBe(true);
    expect(
      workers.every((request) => !promptText(request).includes("turned on deep research")),
    ).toBe(true);
    for (const worker of workers) {
      const prompt = promptText(worker);
      expect(
        prompt.includes("Investigate evidence for the user's question") &&
          prompt.includes("Independently investigate disagreements"),
      ).toBe(false);
    }
  });

  it("keeps a sibling call running when the run beside it finalizes", async () => {
    // The bug this replaces: ending a run ended the whole message, erroring
    // every other call still open on it, including the one that made the call.
    hostReadsAlongside = true;
    readerGate = { reached: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() };
    const gate = readerGate;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(
      send(input.userId, input.conversationId, "Investigate the evidence.", true),
    );
    await runtime.runPromise(
      Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(10))),
    );
    const run = await runtime.runPromise(awaitRunStatus(sent.assistantMessageId, "terminal"));
    expect(run.status).toBe("terminal");
    const during = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        return {
          message: yield* repo.getMessage(sent.assistantMessageId),
          calls: yield* repo.listToolCalls([sent.assistantMessageId]),
        };
      }),
    );
    const sibling = during.calls.find((call) => call.toolName === "read_url")!;
    expect(sibling.status).toBe("running");
    expect(sibling.error).toBeNull();
    expect(during.message?.status).toBe("streaming");
    await runtime.runPromise(Deferred.succeed(gate.release, undefined));
    const events = await runtime.runPromise(collect(sent.assistantMessageId));
    expect(events.at(-1)?.kind).toBe("done");
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        return {
          message: yield* repo.getMessage(sent.assistantMessageId),
          calls: yield* repo.listToolCalls([sent.assistantMessageId]),
        };
      }),
    );
    expect(after.message?.status).toBe("complete");
    expect(after.message?.content).toContain("Supported conclusion");
    expect(after.calls.find((call) => call.id === sibling.id)?.status).toBe("complete");
  });

  it("refuses a second run as a tool result while one is active, and finishes that turn", async () => {
    const input = await runtime.runPromise(seed);
    const release = Deferred.makeUnsafe<void>();
    hold = {
      phase: "report",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
      release,
    };
    const gate = hold;
    const first = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(Deferred.await(gate.reached));
    const other = await runtime.runPromise(
      ChatRepo.use((repo) => repo.createConversation({ userId: input.userId, modelId })),
    );
    hold = null;
    const second = await runtime.runPromise(send(input.userId, other.id, "Investigate again."));
    await runtime.runPromise(collect(second.assistantMessageId));
    const refused = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(second.assistantMessageId))!;
        const call = (yield* repo.listToolCalls([message.id])).find(
          (row) => row.toolName === "deep_research",
        )!;
        return { message, call, run: yield* runOf(message.id) };
      }),
    );
    // A refusal is an answerable tool result, never a failed turn.
    expect(refused.message.status).toBe("complete");
    expect(refused.message.content).toContain("Supported conclusion");
    expect(refused.run).toBeNull();
    expect(refused.call.status).toBe("error");
    expect(refused.call.error?.code).toBe("ResearchIncomplete");
    expect(refused.call.error?.message).toContain("already have an active deep research");
    await runtime.runPromise(Deferred.succeed(release, undefined));
    await runtime.runPromise(collect(first.assistantMessageId));
    expect(
      (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(first.assistantMessageId))))
        ?.status,
    ).toBe("complete");
  });

  it("keeps the offer through a clarification round so the answer can research", async () => {
    hostAsksFirst = true;
    const input = await runtime.runPromise(seed);
    const first = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(first.assistantMessageId));
    // It asked instead of guessing, so no run started yet.
    expect(await runFor(first.assistantMessageId)).toBeNull();
    const answered = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const call = (yield* repo.listToolCalls([first.assistantMessageId])).find(
          (row) => row.toolName === "ask_user",
        )!;
        return yield* ChatService.use((service) =>
          service.sendMessage({
            userId: input.userId,
            conversation: { kind: "existing", id: input.conversationId },
            modelId,
            questionResponse: { callId: call.id, response: { kind: "skip" } },
            searchEnabled: false,
            // What the answering surface sends: it has no toggle of its own.
            researchEnabled: false,
            attachmentIds: [],
          }),
        );
      }),
    );
    await runtime.runPromise(collect(answered.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(answered.assistantMessageId))!;
        expect(message.status).toBe("complete");
        // The offer survived the round trip, so the answer turn could research.
        const run = yield* runOf(message.id);
        expect(run?.status).toBe("terminal");
        expect(
          (yield* repo.listToolCalls([message.id])).some((c) => c.toolName === "deep_research"),
        ).toBe(true);
      }),
    );
  });

  it("refuses a brief too short to investigate without starting a run", async () => {
    hostBrief = "look it up";
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    expect(requests.some((request) => phaseOf(request) === "coordinator")).toBe(false);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        expect(yield* runOf(message.id)).toBeNull();
        const call = (yield* repo.listToolCalls([message.id])).find(
          (row) => row.toolName === "deep_research",
        )!;
        expect(call.status).toBe("error");
        expect(call.error?.message).toContain("what to find out");
      }),
    );
  });

  it("offers the tool only when the send asked for it", async () => {
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(
      Effect.flatMap(ChatService, (service) =>
        service.sendMessage({
          userId: input.userId,
          conversation: { kind: "existing", id: input.conversationId },
          modelId,
          content: "Just answer.",
          researchEnabled: false,
          searchEnabled: false,
          attachmentIds: [],
        }),
      ),
    );
    await runtime.runPromise(collect(sent.assistantMessageId));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolkit?.tools["deep_research"]).toBeUndefined();
    // No tool, no instruction about one.
    expect(promptText(requests[0]!)).not.toContain("turned on deep research");
    expect(
      (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId))))
        ?.status,
    ).toBe("complete");
  });

  it("starts a fresh run for a second call in the same turn", async () => {
    hostPlan = 2;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        const runs = yield* db
          .select()
          .from(researchRuns)
          .where(eq(researchRuns.messageId, message.id))
          .orderBy(asc(researchRuns.createdAt));
        expect(runs).toHaveLength(2);
        expect(runs.every((run) => run.status === "terminal")).toBe(true);
        expect(runs.every((run) => run.generationId === message.generationId)).toBe(true);
        const roots = (yield* repo.listToolCalls([message.id])).filter(
          (call) => call.toolName === "deep_research",
        );
        // Two calls, two rows, two runs: a message can no longer name "its" run.
        expect(roots).toHaveLength(2);
        expect(new Set(runs.map((run) => run.toolCallId))).toEqual(
          new Set(roots.map((call) => call.id)),
        );
        expect(new Set(roots.map((call) => `${call.turnIndex}:${call.callIndex}`)).size).toBe(2);
      }),
    );
  });
});

describe("durable deep research", () => {
  it("publishes compact display progress, not worker reports", async () => {
    finishWorkersEarly = true;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const run = (yield* runOf(sent.assistantMessageId))!;
        const rows = yield* db
          .select()
          .from(messageChunks)
          .where(eq(messageChunks.messageId, sent.assistantMessageId));
        const snapshots = rows
          .filter((row) => row.kind === "tool")
          .map((row) => JSON.parse(row.delta))
          .filter((event) => event.family === "research" && event.progress)
          .map((event) => event.progress);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(snapshots.length).toBeLessThan(20);
        const root = (yield* repo.listToolCalls([sent.assistantMessageId])).find(
          (call) => call.id === run.toolCallId,
        )!;
        for (const progress of [
          run.progress,
          (root.result as Record<string, unknown>).progress as StoredResearchProgress,
          ...snapshots,
        ]) {
          expect(progress).toEqual(projectResearchProgress(progress));
          expect(JSON.stringify(progress)).not.toContain("A bounded finding");
        }
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks.every((task) => task.report?.includes("A bounded finding"))).toBe(true);
        // The evidence reaches the host through the tool result, not the transcript.
        const answer = requests.filter((request) => phaseOf(request) === "host").at(-1)!;
        expect(promptText(answer)).toContain("A bounded finding");
      }),
    );
  });

  it("preserves reports beyond 16000 characters through persistence and the answer", async () => {
    finishWorkersEarly = true;
    reportRepeats = 340;
    reportSuffix = "\nDistinctive trailing finding: the independent replication succeeded[^1].";
    const expectedReport =
      "A bounded finding supported by shared evidence[^1].".repeat(reportRepeats) + reportSuffix;
    expect(expectedReport.length).toBeGreaterThan(16000);
    // A long report can fit the model's output cap without any character-based cutoff.
    expect(
      estimatePromptTokens([
        { role: "assistant", content: [{ type: "text", text: expectedReport }] },
      ]),
    ).toBeLessThan(researchOutputCaps(128000).report);
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        const run = (yield* runOf(message.id))!;
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks).toHaveLength(2);
        for (const task of tasks) expect(task.report).toBe(expectedReport);
        expect(
          run.progress.limitations.filter((limitation) => limitation.startsWith("Task ")),
        ).toEqual([]);
      }),
    );
    const reportRequests = requests.filter((request) => phaseOf(request) === "report");
    expect(reportRequests).toHaveLength(2);
    for (const request of reportRequests) {
      expect(request.maxOutputTokens).toBe(8192);
      expect(promptText(request)).not.toContain("at most 16000 characters");
    }
    expect(requests.some((request) => phaseOf(request) === "compaction")).toBe(false);
  });

  it("keeps length-limited task reports with an explicit model output-limit limitation", async () => {
    finishWorkersEarly = true;
    reportFinishReason = "length";
    reportSuffix = "\nPartial trailing finding retained despite the model output limit[^1].";
    const expectedReport = "A bounded finding supported by shared evidence[^1]." + reportSuffix;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        expect(message.content).toContain("Supported conclusion[^1]");
        const run = (yield* runOf(message.id))!;
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks).toHaveLength(2);
        expect(
          run.progress.limitations.filter((limitation) => limitation.startsWith("Task ")),
        ).toHaveLength(tasks.length);
        for (const task of tasks) {
          expect(task.report).toBe(expectedReport);
          expect(run.progress.limitations).toContain(
            `Task ${task.ordinal}: report reached the model output limit; some findings may be incomplete.`,
          );
        }
        expect(JSON.stringify(run.progress.limitations)).not.toContain(
          "report truncated to 16000 characters",
        );
      }),
    );
  });

  it.each([false, true])(
    "fits multi-wave evidence into an 8k window (summary failure: %s)",
    async (failSummary) => {
      finishWorkersEarly = true;
      dispatchWaves = 3;
      reportRepeats = 70;
      compactionFails = failSummary;
      await runtime.runPromise(
        Db.use((db) =>
          db.update(models).set({ contextLength: 8000 }).where(eq(models.id, modelId)),
        ),
      );
      const input = await runtime.runPromise(seed);
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      await runtime.runPromise(collect(sent.assistantMessageId));
      expect(requests.some((request) => phaseOf(request) === "compaction")).toBe(true);
      const run = await runFor(sent.assistantMessageId);
      expect(
        requests.filter((request) => phaseOf(request) === "report"),
        JSON.stringify(run?.progress),
      ).toHaveLength(6);
      for (const request of requests) {
        expect(
          estimatePromptTokens(request.prompt.content as ReadonlyArray<Prompt.MessageEncoded>),
        ).toBeLessThanOrEqual(
          computeBudget({
            contextLength: 8000,
            outputReserve: request.maxOutputTokens,
            webToolsEnabled: !!request.toolkit,
          }).input,
        );
      }
      const message = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
      );
      expect(message?.status).toBe("complete");
      expect(message?.content).toContain("Supported conclusion");
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const persisted = yield* repo.listCompactionEvents([sent.assistantMessageId]);
          expect(persisted.length).toBeGreaterThan(0);
          if (!failSummary) {
            expect(
              persisted.some((event) => event.summary?.includes("disagreements remain unresolved")),
            ).toBe(true);
          }
          const detail = yield* loadConversationDetail(input.userId, input.conversationId);
          expect(detail.compactionEvents).toHaveLength(persisted.length);
          // Research summaries stay server-side; an ordinary chat compaction in
          // the same window may show its summary by design.
          const research = detail.compactionEvents.filter((event) => event.researchRunId);
          expect(research.length).toBeGreaterThan(0);
          expect(research.every((event) => event.summary === null)).toBe(true);
          const chunks = yield* repo.chunksAfter(sent.assistantMessageId, 0);
          const compactions = chunks.filter((chunk) => chunk.kind === "compaction");
          expect(compactions.length).toBeGreaterThan(0);
          const researchChunks = compactions
            .map((chunk) => JSON.parse(chunk.delta) as Record<string, unknown>)
            .filter((envelope) => envelope.runId);
          expect(researchChunks.length).toBeGreaterThan(0);
          expect(researchChunks.every((envelope) => !("summary" in envelope))).toBe(true);
          const branch = yield* repo.cloneConversationPrefix({
            userId: input.userId,
            sourceConversationId: input.conversationId,
            throughMessageId: sent.assistantMessageId,
          });
          const branched = yield* loadConversationDetail(input.userId, branch.id);
          expect(branched.compactionEvents).toHaveLength(persisted.length);
          const branchedResearch = branched.compactionEvents.filter((event) => event.researchRunId);
          expect(branchedResearch.length).toBeGreaterThan(0);
          expect(branchedResearch.every((event) => event.summary === null)).toBe(true);
        }),
      );
    },
  );

  it("lets workers and the coordinator finish on evidence with most of the budget unspent", async () => {
    finishWorkersEarly = true;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    const calls = await runtime.runPromise(
      ChatRepo.use((repo) => repo.listToolCalls([sent.assistantMessageId])),
    );
    expect(calls.filter((call) => call.toolName === "web_search")).toHaveLength(2);
    expect(requests.filter((request) => phaseOf(request) === "worker")).toHaveLength(4);
    expect(requests.filter((request) => phaseOf(request) === "coordinator")).toHaveLength(2);
    expect(requests.filter((request) => phaseOf(request) === "report")).toHaveLength(2);
    const promptFor = (phase: string) =>
      promptText(requests.find((request) => phaseOf(request) === phase)!);
    expect(promptFor("worker")).toContain("not a fixed source count");
    expect(promptFor("report")).toContain(
      "Distinguish gaps that could materially change the answer from optional detail",
    );
    expect(promptFor("coordinator")).toContain("even with most of the budget left");
    // The host writes the answer with no notion of the run's ceilings.
    expect(promptFor("host")).not.toContain("search/read ceiling");
  });

  it.each(["finish", "text", "empty"] as const)(
    "runs an initial investigation when the coordinator returns %s without dispatching",
    async (response) => {
      coordinatorFirstResponse = response;
      dispatchWaves = 0;
      finishWorkersEarly = true;
      hostBrief = "Verify the result of 9 + 10. Keep the scope limited to this calculation.";
      const input = await runtime.runPromise(seed);
      const sent = await runtime.runPromise(
        send(input.userId, input.conversationId, "what’s 9 + 10?"),
      );
      await runtime.runPromise(collect(sent.assistantMessageId));
      expect(requests.filter((request) => phaseOf(request) === "report")).toHaveLength(1);
      expect(
        requests.filter((request) => phaseOf(request) === "coordinator").length,
      ).toBeLessThanOrEqual(2);
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          expect(message.status).toBe("complete");
          expect(message.content).toContain("Supported conclusion");
          expect(message.content).not.toContain("No investigation is needed");
          const run = (yield* runOf(message.id))!;
          expect(run.progress.limitations).not.toContain(
            "No usable research reports were produced.",
          );
          expect(run.progress.limitations).not.toContain(
            "A coordinator round dispatched no useful tasks.",
          );
          const tasks = yield* db
            .select()
            .from(researchTasks)
            .where(eq(researchTasks.runId, run.id));
          expect(tasks).toHaveLength(1);
          expect(tasks[0]).toMatchObject({ assignment: hostBrief, status: "complete", ordinal: 1 });
          const calls = yield* db
            .select()
            .from(researchCalls)
            .where(eq(researchCalls.runId, run.id));
          expect(calls).toHaveLength(runRequests().length);
          expect(
            (yield* db.select().from(usageEvents).where(eq(usageEvents.id, run.id)))[0]
              ?.inputTokens,
          ).toBe(calls.length * 100);
        }),
      );
    },
  );

  it("captures the stored search cap once and applies admin changes to the next retry", async () => {
    await runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", { config: { researchMaxSearchQueries: 12 } }),
      ),
    );
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const gate = {
      phase: "coordinator",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
      release: Deferred.makeUnsafe<void>(),
    };
    hold = gate;
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(
      Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(5))),
    );
    // The run has captured 12; an admin patch must not enlarge it mid-investigation.
    const patched = await runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", { config: { researchMaxSearchQueries: 24 } }),
      ),
    );
    expect(patched?.config).toMatchObject({ backend: "searxng", researchMaxSearchQueries: 24 });
    hold = null;
    await runtime.runPromise(Deferred.succeed(gate.release, undefined));
    await runtime.runPromise(collect(sent.assistantMessageId));
    expect(backendSearches).toBe(12);
    const firstCoordinator = requests.find((request) => phaseOf(request) === "coordinator")!;
    expect(JSON.stringify(firstCoordinator.prompt.content.at(-1))).toContain("about 12 searches");
    requests.length = 0;
    backendSearches = 0;
    coordinatorTurns = 0;
    await runtime.runPromise(
      ChatService.use((service) =>
        service.retryMessage({ ...input, messageId: sent.assistantMessageId }),
      ),
    );
    await runtime.runPromise(collect(sent.assistantMessageId));
    expect(backendSearches).toBe(24);
    const retryCoordinator = requests.find((request) => phaseOf(request) === "coordinator")!;
    expect(JSON.stringify(retryCoordinator.prompt.content.at(-1))).toContain("about 24 searches");
    // A later unrelated patch must preserve the saved cap.
    const toggled = await runtime.runPromise(
      ToolsRepo.use((repo) => repo.updateTool("web_search", { enabled: false })),
    );
    expect(toggled?.config.researchMaxSearchQueries).toBe(24);
  });
});

describe("ending a run", () => {
  it.each(["coordinator", "worker", "report"])(
    "Stop during %s interrupts the scoped provider and leaves run and message terminal",
    async (phase) => {
      const input = await runtime.runPromise(seed);
      hold = {
        phase,
        reached: Deferred.makeUnsafe<void>(),
        interrupted: Deferred.makeUnsafe<void>(),
      };
      const gate = hold;
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      await runtime.runPromise(
        Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(10))),
      );
      const generationId = await generationOf(sent.assistantMessageId);
      // Stop knows the attempt, never the run: a turn may start several.
      const stale = await runtime.runPromise(
        ChatService.use((service) =>
          service.stopGeneration({
            ...input,
            messageId: sent.assistantMessageId,
            generationId: "old-generation",
          }),
        ),
      );
      expect(stale.stopped).toBe(false);
      const countAtStop = requests.length;
      const stopped = await runtime.runPromise(
        ChatService.use((service) =>
          service.stopGeneration({ ...input, messageId: sent.assistantMessageId, generationId }),
        ),
      );
      expect(stopped.stopped).toBe(true);
      await runtime.runPromise(
        Deferred.await(gate.interrupted).pipe(Effect.timeout(Duration.seconds(5))),
      );
      await runtime.runPromise(collect(sent.assistantMessageId, generationId));
      // At most the batch already dispatched when Stop landed; no new round.
      expect(requests.length).toBeLessThanOrEqual(countAtStop + RESEARCH_LIMITS.workers);
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          expect(message.status).toBe("aborted");
          const run = (yield* runOf(message.id))!;
          expect(run.status).toBe("terminal");
          expect(run.owner).toBeNull();
          expect(run.progress.phase).toBe("aborted");
        }),
      );
    },
  );

  it("retries with a fresh run and leaves the stopped one in the ledger", async () => {
    const input = await runtime.runPromise(seed);
    hold = {
      phase: "coordinator",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
    };
    const gate = hold;
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(
      Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(10))),
    );
    const firstGeneration = await generationOf(sent.assistantMessageId);
    const firstRun = (await runFor(sent.assistantMessageId))!;
    await runtime.runPromise(
      ChatService.use((service) =>
        service.stopGeneration({
          ...input,
          messageId: sent.assistantMessageId,
          generationId: firstGeneration,
        }),
      ),
    );
    await runtime.runPromise(
      Deferred.await(gate.interrupted).pipe(Effect.timeout(Duration.seconds(5))),
    );
    await runtime.runPromise(collect(sent.assistantMessageId, firstGeneration));
    hold = null;
    coordinatorTurns = 0;
    await runtime.runPromise(
      ChatService.use((service) =>
        service.retryMessage({ ...input, messageId: sent.assistantMessageId }),
      ),
    );
    await runtime.runPromise(collect(sent.assistantMessageId));
    const retried = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
    ))!;
    expect(retried.status).toBe("complete");
    expect(retried.generationId).not.toBe(firstGeneration);
    const fresh = (await runFor(sent.assistantMessageId))!;
    expect(fresh.id).not.toBe(firstRun.id);
    expect(fresh.generationId).toBe(retried.generationId);
    const oldStream = await runtime.runPromise(collect(sent.assistantMessageId, firstGeneration));
    expect(oldStream).toHaveLength(1);
    expect(oldStream[0]).toMatchObject({ kind: "done", runId: retried.generationId });
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const ledger = yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.messageId, sent.assistantMessageId));
        expect(ledger.map((row) => row.id)).toEqual(
          expect.arrayContaining([firstRun.id, fresh.id]),
        );
      }),
    );
  });

  it("reaps only expired owners, preserves partial chunks and makes finalization idempotent", async () => {
    const input = await runtime.runPromise(seed);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const turn = yield* repo.createTurn({
          userId: input.userId,
          conversation: { kind: "existing", id: input.conversationId },
          modelId,
          content: "first",
          attachmentIds: [],
        });
        const generationId = (yield* db
          .select({ generationId: messages.generationId })
          .from(messages)
          .where(eq(messages.id, turn.assistant.id)))[0]!.generationId!;
        // A run is started by a call, so the test mints the row the same way
        // the stream observer does before queueing one.
        const rowId = uuidv7();
        yield* repo.insertToolCall({
          id: rowId,
          messageId: turn.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          providerCallId: "reaper-call",
          toolName: "deep_research",
          arguments: {},
        });
        const runId = yield* repo.research!.queue({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: turn.assistant.id,
          generationId,
          toolCallId: rowId,
          modelId,
        });
        const claimed = (yield* repo.research!.claim(runId))!;
        yield* repo.research!.locked(claimed.fence, (tx) =>
          tx
            .insert(messageChunks)
            .values({
              messageId: turn.assistant.id,
              seq: 1,
              kind: "text",
              delta: "Retained partial report",
            })
            .pipe(Effect.orDie, Effect.asVoid),
        );
        yield* repo.research!.reap();
        expect((yield* repo.research!.get(runId))?.status).toBe("running");
        yield* db
          .update(researchRuns)
          .set({ leaseUntil: sql`now() - interval '1 second'` })
          .where(eq(researchRuns.id, runId));
        yield* Effect.all([repo.research!.reap(), repo.research!.reap()], { concurrency: 2 });
        expect((yield* repo.research!.get(runId))?.progress.phase).toBe("interrupted");
        // Reaping the run must not end the message: the generation owns that.
        expect((yield* repo.getMessage(turn.assistant.id))?.status).toBe("streaming");
        const late = yield* Effect.exit(
          repo.research!.locked(claimed.fence, (tx) =>
            tx
              .insert(messageToolCalls)
              .values({
                id: uuidv7(),
                messageId: turn.assistant.id,
                turnIndex: 99,
                callIndex: 0,
                providerCallId: "late",
                toolName: "web_search",
                arguments: {},
                status: "running",
              })
              .pipe(Effect.orDie, Effect.asVoid),
          ),
        );
        expect(late._tag).toBe("Failure");
        expect(yield* db.select().from(usageEvents).where(eq(usageEvents.id, runId))).toHaveLength(
          1,
        );
        // The call that started it is untouched: only the generation settles it.
        expect((yield* repo.listToolCalls([turn.assistant.id]))[0]).toMatchObject({
          id: rowId,
          status: "running",
        });
        yield* repo.research!.cancelForGeneration(turn.assistant.id, generationId);
      }),
    );
  });

  it("settles expired research after its message was reaped and retried", async () => {
    const input = await runtime.runPromise(seed);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const turn = yield* repo.createTurn({
          userId: input.userId,
          conversation: { kind: "existing", id: input.conversationId },
          modelId,
          content: "first",
          attachmentIds: [],
        });
        const generationId = turn.assistant.generationId!;
        const toolCallId = uuidv7();
        yield* repo.insertToolCall({
          id: toolCallId,
          messageId: turn.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "old-generation-research",
          toolName: "deep_research",
          arguments: {},
        });
        const runId = yield* repo.research!.queue({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: turn.assistant.id,
          generationId,
          toolCallId,
          modelId,
        });
        const claimed = (yield* repo.research!.claim(runId))!;
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(messages.id, turn.assistant.id));
        expect(yield* repo.reapExpiredGenerations()).toHaveLength(1);
        expect((yield* repo.research!.get(runId))?.status).toBe("running");
        const snapshot = yield* repo.listMessages(input.conversationId);
        const retried = yield* repo.resetMessageForRetry({
          userId: input.userId,
          messageId: turn.assistant.id,
          modelId,
          expectedMessages: snapshot,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
        });
        expect(retried.claimed).toBe(true);
        expect(retried.generationId).not.toBe(generationId);
        expect(yield* repo.research!.finalize(runId, "complete", claimed.fence.owner)).toBe(false);
        yield* db
          .update(researchRuns)
          .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(researchRuns.id, runId));
        yield* repo.research!.reap();
        const settled = yield* repo.research!.get(runId);
        expect(settled?.status).toBe("terminal");
        expect(settled?.progress.phase).toBe("interrupted");
        expect((yield* repo.getMessage(turn.assistant.id))?.status).toBe("streaming");
        expect(yield* db.select().from(usageEvents).where(eq(usageEvents.id, runId))).toHaveLength(
          1,
        );
        const nextCallId = uuidv7();
        yield* repo.insertToolCall({
          id: nextCallId,
          messageId: turn.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "new-generation-research",
          toolName: "deep_research",
          arguments: {},
        });
        const nextId = yield* repo.research!.queue({
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: turn.assistant.id,
          generationId: retried.generationId!,
          toolCallId: nextCallId,
          modelId,
        });
        expect(nextId).not.toBe(runId);
      }),
    );
  });

  it("checkpoints active research usage before conversation deletion and interrupts its owner", async () => {
    const input = await runtime.runPromise(seed);
    const release = Deferred.makeUnsafe<void>();
    hold = {
      phase: "report",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
      release,
    };
    const gate = hold;
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    try {
      await runtime.runPromise(Deferred.await(gate.reached));
      const run = (await runFor(sent.assistantMessageId))!;
      const generationId = await generationOf(sent.assistantMessageId);
      await remote.runPromise(ChatService.use((service) => service.deleteConversation(input)));
      hold = null;
      await runtime.runPromise(Deferred.succeed(release, undefined));
      await runtime.runPromise(
        StreamEngine.use((engine) => engine.awaitSettled(sent.assistantMessageId, generationId)),
      );
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const repo = yield* ChatRepo;
          expect(yield* repo.getMessage(sent.assistantMessageId)).toBeNull();
          expect(
            yield* db.select().from(researchRuns).where(eq(researchRuns.id, run.id)),
          ).toHaveLength(0);
          expect(
            yield* db.select().from(researchCalls).where(eq(researchCalls.runId, run.id)),
          ).toHaveLength(0);
          const ledger = yield* db.select().from(usageEvents).where(eq(usageEvents.id, run.id));
          expect(ledger).toHaveLength(1);
          expect(ledger[0]!.inputTokens).toBeGreaterThan(0);
          expect(ledger[0]!.usageComplete).toBe(false);
          expect(ledger[0]!.status).toBe("aborted");
          expect(ledger[0]!.conversationId).toBe(input.conversationId);
          expect(ledger[0]!.messageId).toBe(sent.assistantMessageId);
          yield* repo.research!.reap();
          expect(
            yield* db.select().from(usageEvents).where(eq(usageEvents.id, run.id)),
          ).toHaveLength(1);
        }),
      );
    } finally {
      hold = null;
      await runtime.runPromise(Deferred.succeed(release, undefined));
    }
  });

  it("retains stopped research source numbers in a subsequent attempt", async () => {
    const input = await runtime.runPromise(seed);
    hold = {
      phase: "report",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
    };
    const gate = hold;
    const first = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(Deferred.await(gate.reached));
    const generationId = await generationOf(first.assistantMessageId);
    await runtime.runPromise(
      ChatService.use((service) =>
        service.stopGeneration({
          ...input,
          messageId: first.assistantMessageId,
          generationId,
        }),
      ),
    );
    await runtime.runPromise(Deferred.await(gate.interrupted));
    await runtime.runPromise(
      StreamEngine.use((engine) => engine.awaitSettled(first.assistantMessageId, generationId)),
    );
    await runtime.runPromise(collect(first.assistantMessageId, generationId));
    expect(
      (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(first.assistantMessageId))))
        ?.status,
    ).toBe("aborted");
    hold = null;
    requests.length = 0;
    coordinatorTurns = 0;
    evidenceUrl = "https://evidence.example/followup";
    const second = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(second.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const calls = yield* repo.listToolCalls([second.assistantMessageId]);
        const sources = calls
          .filter((call) => call.toolName === "web_search")
          .flatMap(
            (call) =>
              (call.result as { sources?: { index: number; url: string }[] } | null)?.sources ?? [],
          );
        expect(sources.length).toBeGreaterThan(0);
        expect(sources.every((source) => source.index === 2 && source.url === evidenceUrl)).toBe(
          true,
        );
        expect((yield* repo.getMessage(second.assistantMessageId))?.status).toBe("complete");
      }),
    );
    const worker = requests.find((request) => phaseOf(request) === "worker")!;
    // Citation identity survives, but unrelated inherited evidence is not
    // injected into every worker.
    expect(promptText(worker)).not.toContain("https://evidence.example/source");
  });

  it.each([
    ["provider", "A research provider request failed (InvalidRequestError; HTTP 400)."],
    ["context", "The provider rejected the research context size."],
    ["defect", "Research stopped because of an execution failure."],
  ] as const)(
    "reports a safe %s diagnostic as a tool result and still finishes the turn",
    async (failure, diagnostic) => {
      const input = await runtime.runPromise(seed);
      coordinatorFailure = failure;
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      const events = await runtime.runPromise(collect(sent.assistantMessageId));
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const repo = yield* ChatRepo;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          // The investigation failed; the turn it ran inside did not.
          expect(message.status).toBe("complete");
          expect(message.content).toContain("Supported conclusion");
          const run = (yield* runOf(message.id))!;
          expect(
            yield* db
              .select()
              .from(researchCalls)
              .where(and(eq(researchCalls.runId, run.id), eq(researchCalls.phase, "worker"))),
          ).toHaveLength(0);
          expect(run.progress.phase).toBe("error");
          expect(run.progress.tasks).toHaveLength(0);
          expect(run.progress.limitations.join(" ")).toContain(diagnostic);
          expect(run.progress.limitations).toContain("No usable research reports were produced.");
          expect(run.progress.limitations.join(" ")).not.toMatch(
            /deadline|time limit|execution limit/,
          );
          const root = (yield* repo.listToolCalls([message.id])).find(
            (call) => call.toolName === "deep_research",
          )!;
          expect(root.status).toBe("error");
          expect(JSON.stringify(root.result)).toContain(diagnostic);
          expect(JSON.stringify({ message, progress: run.progress, root, events })).not.toMatch(
            /PRIVATE_PROVIDER_PAYLOAD|authorization=secret/,
          );
        }),
      );
    },
  );
});

describe("what the investigation may see", () => {
  it("keeps history, memories and draft tools with the host and delegates only the brief", async () => {
    finishWorkersEarly = true;
    hostDraft = true;
    const input = await runtime.runPromise(seed);
    await enableMemory(input.userId);
    const privateMemory = "Grows orchids in a private greenhouse.";
    const privateHistory = "My unrelated draft project is called Quiet Observatory.";
    await runtime.runPromise(
      MemoryService.use((service) => service.createManual(input.userId, privateMemory)),
    );
    await runtime.runPromise(
      ChatRepo.use((repo) =>
        repo.insertMessage({
          conversationId: input.conversationId,
          role: "user",
          content: privateHistory,
        }),
      ),
    );
    hostBrief =
      "Compare independent evidence for European regulations. Prefer European primary sources.";
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    const hosts = requests.filter((request) => phaseOf(request) === "host");
    expect(hosts.length).toBeGreaterThan(0);
    expect(promptText(hosts[0]!)).toContain(privateMemory);
    expect(promptText(hosts[0]!)).toContain(privateHistory);
    const coordinator = requests.find((request) => phaseOf(request) === "coordinator")!;
    expect(promptText(coordinator)).toContain(hostBrief);
    for (const request of requests.filter((request) =>
      ["coordinator", "worker", "report"].includes(phaseOf(request)),
    )) {
      expect(promptText(request)).not.toContain(privateMemory);
      expect(promptText(request)).not.toContain(privateHistory);
      expect(promptText(request)).not.toContain("PRIVATE_");
      expect(request.toolkit?.tools["save_memory"]).toBeUndefined();
      expect(request.toolkit?.tools["deep_research"]).toBeUndefined();
      expect(request.toolkit?.tools["draft_agent"]).toBeUndefined();
      expect(request.toolkit?.tools["update_agent_draft"]).toBeUndefined();
    }
    const draft = await runtime.runPromise(
      AgentDraftService.use((service) =>
        service
          .list(input.userId, input.conversationId)
          .pipe(Effect.map((drafts) => drafts[0] ?? null)),
      ),
    );
    expect(draft).toMatchObject({
      revision: 2,
      targetId: null,
      settings: { instructions: "PRIVATE_RESEARCH_DRAFT" },
    });
    const detail = await runtime.runPromise(
      loadConversationDetail(input.userId, input.conversationId),
    );
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
    const message = detail.messages.at(-1)!;
    expect(message.status).toBe("complete");
    expect(message.content.match(/I found useful guidance/g)).toHaveLength(1);
    const chunks = await runtime.runPromise(
      ChatRepo.use((repo) => repo.chunksAfter(sent.assistantMessageId, 0)),
    );
    expect(JSON.stringify(chunks)).not.toContain("PRIVATE_");
  });

  it("stops exploring once the search backend is down instead of spending every round on it", async () => {
    searchDown = true;
    queriesPerSearch = 3;
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    const workers = requests.filter((request) => phaseOf(request) === "worker");
    // The synchronous fake fails each actual query. A batched tool result must
    // not collapse those failures into one observation or count refusals as more.
    expect(backendSearches).toBe(RESEARCH_LIMITS.searchOutageThreshold);
    // A handful of failures is a worker rephrasing; a run of them is an outage,
    // after which no worker, coordinator round or dispatch keeps spending calls.
    expect(workers.length).toBeLessThanOrEqual(RESEARCH_LIMITS.searchOutageThreshold + 3);
    expect(requests.filter((request) => phaseOf(request) === "coordinator").length).toBeLessThan(
      RESEARCH_LIMITS.coordinatorRounds,
    );
    const run = await runFor(sent.assistantMessageId);
    expect(run?.progress.limitations).toContain(
      "Web search was unavailable, so most of the investigation could not run.",
    );
  });

  it("tells workers and the coordinator what is left, and tightens as it runs out", async () => {
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    const noticeOf = (request: GatewayInput) => JSON.stringify(request.prompt.content.at(-1) ?? "");
    const workers = requests.filter((entry) => phaseOf(entry) === "worker");
    const coordinators = requests.filter((entry) => phaseOf(entry) === "coordinator");
    // Every exploring turn ends on a user-role budget line, never an assistant
    // prefill, and states what remains.
    for (const request of [...workers, ...coordinators]) {
      expect(request.prompt.content.at(-1)?.role).toBe("user");
      expect(noticeOf(request)).toContain("Remaining budget (ceiling, not a target):");
    }
    expect(noticeOf(coordinators[0]!)).toContain("task slots");
    expect(noticeOf(workers[0]!)).toContain("for your task");
    // Guidance escalates rather than only appearing at the ceiling.
    expect(noticeOf(workers[0]!)).toContain("end the turn without tool calls");
    expect(noticeOf(workers.at(-1)!)).toContain("nearly spent");
  });

  it("budgets every dispatch wave and actual call, then hands the evidence back", async () => {
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    // The tool's own per-call maximum, so exploration meets the search ceiling.
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(collect(sent.assistantMessageId));
    // Exploration stops when the web budget is gone rather than spending the
    // remaining model calls on tools that can only refuse.
    expect(runRequests().length).toBeLessThanOrEqual(RESEARCH_LIMITS.calls);
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        const run = (yield* runOf(message.id))!;
        const calls = yield* db.select().from(researchCalls).where(eq(researchCalls.runId, run.id));
        expect(calls).toHaveLength(runRequests().length);
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks.length).toBeLessThanOrEqual(RESEARCH_LIMITS.tasks);
        const webCalls = (yield* repo.listToolCalls([message.id])).filter(
          (call) => call.toolName === "web_search",
        );
        // The final batch can complete with two admitted queries and one
        // refusal: completed tool calls times batch size would incorrectly say 81.
        // Count backend execution to pin the exact ceiling, including its
        // partial final batch, rather than rounding down.
        expect(backendSearches).toBe(RESEARCH_LIMITS.searches);
        // At most the batch in flight when the ceiling was reached, not a
        // cascade of refusals across every remaining round.
        expect(webCalls.filter((call) => call.status === "error").length).toBeLessThanOrEqual(
          RESEARCH_LIMITS.workers,
        );
        // Spending the budget is the design, not a defect worth reporting.
        expect(run.progress.limitations.some((l) => /search|page read/.test(l))).toBe(false);
        expect(run.progress.limitations).not.toContain(
          "A coordinator round dispatched no useful tasks.",
        );
      }),
    );
    // The host is told the investigation hit its ceiling, so its answer can say so.
    const answer = requests.filter((request) => phaseOf(request) === "host").at(-1)!;
    expect(promptText(answer)).toContain("search/read ceiling");
  });

  // A worker's prompt is already only its assignment, so repair has nothing to
  // shed there; the stages that carry projected evidence are the ones that do.
  it.each(["coordinator", "report"])(
    "repairs %s context overflow without reintroducing assistant prefill and counts the rejected invocation",
    async (phase) => {
      const input = await runtime.runPromise(seed);
      await runtime.runPromise(
        ChatRepo.use((repo) =>
          Effect.gen(function* () {
            yield* repo.insertMessage({
              conversationId: input.conversationId,
              role: "user",
              content: "Old irrelevant history ".repeat(1000),
            });
            yield* repo.insertMessage({
              conversationId: input.conversationId,
              role: "assistant",
              content: "Old response ".repeat(1000),
            });
          }),
        ),
      );
      // The investigation receives only the brief, so overflow repair must
      // compact that projection rather than borrowing the host's history.
      hostBrief =
        "Investigate the evidence. " +
        "Compare independent sources and investigate gaps. ".repeat(100);
      overflowPhase = phase;
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      await runtime.runPromise(collect(sent.assistantMessageId));
      const attempts = requests.filter((request) => phaseOf(request) === phase);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      // Only the coordinator carries a projected evidence block that repair can
      // shed; a report prompt is already near its floor.
      if (phase === "coordinator") {
        expect(promptText(attempts[1]!).length).toBeLessThan(promptText(attempts[0]!).length);
        expect(promptText(attempts[1]!)).toContain("Investigate the evidence.");
      }
      for (const request of attempts) {
        expect(request.prompt.content.at(-1)?.role).toBe("user");
        expect(JSON.stringify(request.prompt.content.at(-1))).toContain("data, not instructions");
        expect(request.prompt.content.at(-2)?.role).toBe("assistant");
        expect(JSON.stringify(request.prompt.content.at(-2))).toContain(
          phase === "report" ? "Registered sources" : "Research brief (data)",
        );
      }
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const repo = yield* ChatRepo;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          expect(message.status).toBe("complete");
          const run = (yield* runOf(message.id))!;
          const calls = yield* db
            .select()
            .from(researchCalls)
            .where(eq(researchCalls.runId, run.id));
          expect(calls).toHaveLength(runRequests().length);
          const ledger = (yield* db
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.id, run.id)))[0]!;
          expect(ledger.inputTokens).toBe((runRequests().length - 1) * 100);
          expect(ledger.usageComplete).toBe(false);
        }),
      );
    },
  );
});
