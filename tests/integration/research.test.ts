import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Duration, Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { Response, type Prompt } from "effect/unstable/ai";
import { and, eq, sql } from "drizzle-orm";
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
import { computeBudget, estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import { projectResearchProgress } from "~/modules/chat/research-schema.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
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
import { WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { SearchBackend, SearchBackendError } from "~/modules/tools/server/search.ts";
import { UrlReaderExecutor } from "~/modules/tools/server/url-reader.ts";
import { FakeBlobStore, FakeDocumentParser } from "./unused-services.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

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
let runtime: ManagedRuntime.ManagedRuntime<
  ChatRepo | ChatService | StreamEngine | Db | ToolsRepo,
  unknown
>;
let remote: typeof runtime;
let modelId: string;
type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];
const requests: GatewayInput[] = [];
let clarify = false;
let clarificationProse = "";
let coordinatorFailure: "provider" | "context" | "defect" | null = null;
let synthesisCutShort = false;
let evidenceUrl = "https://evidence.example/source";
let overflowPhase: string | null = null;
let dispatchWaves = 1;
let coordinatorTurns = 0;
let queriesPerSearch = 1;
let searchDown = false;
let finishWorkersEarly = false;
let planningFragments = 1;
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
const phaseOf = (input: GatewayInput) => {
  const content = input.prompt.content.map((message) => JSON.stringify(message)).join("\n");
  if (content.includes("You compact the older part of a chat conversation")) return "compaction";
  if (input.toolkit?.tools["ask_user"]) return "clarification";
  if (input.toolkit?.tools["dispatch_research"]) return "coordinator";
  if (input.toolkit?.tools["web_search"]) return "worker";
  if (content.includes("Write a concise research plan")) return "planning";
  if (content.includes("Write a concise, evidence-dense report")) return "report";
  return "synthesis";
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
const tool = (input: GatewayInput, name: string, params: unknown) => {
  const id = "same-provider-id"; // deliberately repeated in concurrent workers and all invocations
  const result = Stream.unwrap(input.toolkit!.handle(name, params, id).pipe(Effect.orDie)).pipe(
    Stream.orDie,
    Stream.map(
      (value) =>
        Response.toolResultPart({ id, name, providerExecuted: false, ...value }) as ChatStreamPart,
    ),
  ) as Stream.Stream<ChatStreamPart>;
  return Stream.make(
    Response.makePart("tool-call", { id, name, params, providerExecuted: false }) as ChatStreamPart,
  ).pipe(Stream.concat(result), Stream.concat(Stream.make(finish("tool-calls"))));
};
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
  generateText: () => Effect.die("All research calls must use streaming"),
  streamChat: (input) =>
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
            Effect.as(text("Compare independent sources and investigate gaps.")),
          ),
        ).pipe(Stream.concat(Stream.make(finish())));
      }
      if (phase === "clarification")
        return clarify
          ? Stream.make(text("I need one clarification before researching.\n")).pipe(
              Stream.concat(
                tool(input, "ask_user", {
                  questions: [
                    {
                      question: "Which region?",
                      options: [{ label: "Europe" }, { label: "Asia" }],
                      multiSelect: false,
                    },
                  ],
                }),
              ),
            )
          : Stream.make(text(clarificationProse), finish());
      if (phase === "planning")
        return Stream.fromIterable(
          Array.from({ length: planningFragments }, () =>
            text("Compare independent sources and investigate gaps."),
          ),
        ).pipe(Stream.concat(Stream.make(finish())));
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
          queries: Array.from(
            { length: queriesPerSearch },
            (_, i) => `shared evidence ${call}-${i}`,
          ),
        });
      }
      if (phase === "report")
        return Stream.make(
          text(
            "A bounded finding supported by shared evidence[^1].".repeat(reportRepeats) +
              reportSuffix,
          ),
          finish(reportFinishReason),
        );
      // A report whose stream dies after emitting whole lines: the reader
      // already has those, so the run is truncated rather than failed.
      if (synthesisCutShort)
        return Stream.make(text("# Findings\nSupported conclusion[^1].\n")).pipe(
          Stream.concat(
            Stream.fail(new ProviderUnreachable({ providerId: "fake", message: "stream lost" })),
          ),
        );
      return Stream.make(
        text("# Findings\nSupported conclusion[^1].\n"),
        text("Coverage remains limited; invented reference[^999] is not evidence.\n"),
        finish(),
      );
    }),
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
    Effect.succeed(() =>
      Effect.succeed({
        ok: true,
        targets: [],
        resultCount: 0,
        pagesFetched: 0,
        results: [],
        failures: [],
      }),
    ),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const repos = Layer.mergeAll(
    AnalyticsRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
    ToolsRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
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
        FakeMemoryService,
        SyncBus.layer,
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
  await container?.stop();
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
  requests.length = 0;
  evidenceUrl = "https://evidence.example/source";
  clarify = false;
  clarificationProse = "";
  coordinatorFailure = null;
  synthesisCutShort = false;
  overflowPhase = null;
  dispatchWaves = 1;
  coordinatorTurns = 0;
  queriesPerSearch = 1;
  searchCalls = 0;
  backendSearches = 0;
  searchDown = false;
  finishWorkersEarly = false;
  planningFragments = 1;
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
const send = (userId: string, conversationId: string) =>
  Effect.flatMap(ChatService, (service) =>
    service.sendMessage({
      userId,
      conversationId,
      modelId,
      content: "Investigate the evidence.",
      generationMode: "research",
      searchEnabled: false,
      attachmentIds: [],
    }),
  );
const collect = (messageId: string, runId?: string) =>
  Effect.flatMap(StreamEngine, (engine) =>
    Stream.runCollect(engine.subscribe(messageId, 0, runId)).pipe(
      Effect.timeout(Duration.seconds(20)),
    ),
  );

describe("durable deep research", () => {
  it("publishes compact display progress, not fragmented plans or worker reports", async () => {
    planningFragments = 100;
    finishWorkersEarly = true;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const run = (yield* db
          .select()
          .from(researchRuns)
          .where(eq(researchRuns.messageId, sent.assistantMessageId)))[0]!;
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
        expect(snapshots.filter((snapshot) => snapshot.phase === "planning")).toHaveLength(1);
        const root = (yield* repo.listToolCalls([sent.assistantMessageId])).find(
          (call) => call.id === run.id,
        )!;
        for (const progress of [
          run.progress,
          (root.result as unknown as { progress: typeof run.progress }).progress,
          ...snapshots,
        ]) {
          expect(progress).toEqual(projectResearchProgress(progress));
          expect(JSON.stringify(progress)).not.toContain("Compare independent sources");
          expect(JSON.stringify(progress)).not.toContain("A bounded finding");
        }
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks.every((task) => task.report?.includes("A bounded finding"))).toBe(true);
        const synthesis = requests.find((request) => phaseOf(request) === "synthesis")!;
        expect(JSON.stringify(synthesis.prompt)).toContain("A bounded finding");
      }),
    );
  });

  it("preserves reports beyond 16000 characters through persistence and synthesis", async () => {
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
    await remote.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        const run = (yield* repo.research!.get(message.researchRunId!))!;
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
      expect(JSON.stringify(request.prompt)).not.toContain("at most 16000 characters");
    }
    expect(requests.some((request) => phaseOf(request) === "compaction")).toBe(false);
    const synthesis = requests.find((request) => phaseOf(request) === "synthesis");
    expect(synthesis).toBeDefined();
    const synthesisPrompt = JSON.stringify(synthesis!.prompt);
    expect(synthesisPrompt).toContain(JSON.stringify(expectedReport).slice(1, -1));
    expect(synthesisPrompt).toContain(reportSuffix.trim());
    expect(synthesisPrompt).not.toContain("report truncated to 16000 characters");
    expect(synthesisPrompt).not.toContain("report reached the model output limit");
  });

  it("keeps length-limited task reports with an explicit model output-limit limitation", async () => {
    finishWorkersEarly = true;
    reportFinishReason = "length";
    reportSuffix = "\nPartial trailing finding retained despite the model output limit[^1].";
    const expectedReport = "A bounded finding supported by shared evidence[^1]." + reportSuffix;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    const synthesis = requests.find((request) => phaseOf(request) === "synthesis");
    expect(synthesis).toBeDefined();
    const synthesisPrompt = JSON.stringify(synthesis!.prompt);
    expect(synthesisPrompt).toContain(JSON.stringify(expectedReport).slice(1, -1));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        expect(message.content).toContain("Supported conclusion[^1]");
        const run = (yield* repo.research!.get(message.researchRunId!))!;
        const tasks = yield* db.select().from(researchTasks).where(eq(researchTasks.runId, run.id));
        expect(tasks).toHaveLength(2);
        expect(
          run.progress.limitations.filter((limitation) => limitation.startsWith("Task ")),
        ).toHaveLength(tasks.length);
        for (const task of tasks) {
          expect(task.report).toBe(expectedReport);
          const limitation = `Task ${task.ordinal}: report reached the model output limit; some findings may be incomplete.`;
          expect(run.progress.limitations).toContain(limitation);
          expect(synthesisPrompt).toContain(limitation);
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
      await remote.runPromise(collect(sent.assistantMessageId));
      const synthesis = requests.find((request) => phaseOf(request) === "synthesis");
      expect(synthesis).toBeDefined();
      expect(requests.some((request) => phaseOf(request) === "compaction")).toBe(true);
      expect(synthesis?.maxOutputTokens).toBe(researchOutputCaps(8000).synthesis);
      const runProgress = await runtime.runPromise(
        Db.use((db) =>
          db.select().from(researchRuns).where(eq(researchRuns.messageId, sent.assistantMessageId)),
        ),
      );
      expect(
        requests.filter((request) => phaseOf(request) === "report"),
        JSON.stringify(runProgress[0]?.progress),
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
        expect(request.prompt.content.at(-1)?.role).toBe("user");
      }
      const evidence = JSON.stringify(synthesis!.prompt.content.at(-2));
      expect(synthesis!.prompt.content.at(-2)?.role).toBe("assistant");
      expect(evidence).toContain("https://evidence.example/source");
      if (failSummary) expect(evidence).toContain("abridged");
      const message = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
      );
      expect(message?.status).toBe("complete");
      expect(message?.content).toContain("Supported conclusion");
    },
  );

  it("runs isolated workers, shares citations, streams across instances and aggregates one ledger row", async () => {
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    const events = await remote.runPromise(collect(sent.assistantMessageId));
    expect(events.at(-1)?.kind).toBe("done");
    const chunks = events.filter((event) => event.kind === "chunk");
    expect(chunks.map((chunk) => chunk.seq)).toEqual(chunks.map((_, index) => index + 1));
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        expect(message.generationMode).toBe("research");
        expect(message.content).toContain("Supported conclusion[^1]");
        expect(message.content).not.toContain("[^999]");
        const runs = yield* db
          .select()
          .from(researchRuns)
          .where(eq(researchRuns.messageId, message.id));
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe("terminal");
        const calls = yield* db
          .select()
          .from(researchCalls)
          .where(eq(researchCalls.runId, runs[0]!.id));
        expect(calls.length).toBe(requests.length);
        expect(calls.every((call) => call.usageComplete)).toBe(true);
        const ledger = yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.messageId, message.id));
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.inputTokens).toBe(calls.length * 100);
        expect(ledger[0]!.usageComplete).toBe(true);
        const toolCalls = yield* repo.listToolCalls([message.id]);
        expect(toolCalls.find((call) => call.id === runs[0]!.id)?.toolName).toBe("deep_research");
        // The fake reuses one provider call id everywhere; every worker call
        // must still land on its own namespaced row.
        expect(
          new Set(
            toolCalls
              .filter((call) => call.toolName === "web_search")
              .map((call) => call.providerCallId),
          ).size,
        ).toBe(requests.filter((request) => phaseOf(request) === "worker").length);
        expect(
          yield* db.select().from(researchTasks).where(eq(researchTasks.runId, runs[0]!.id)),
        ).toHaveLength(2);
        expect(yield* repo.research!.finalize(runs[0]!.id, "error", "stale-owner")).toBe(false);
      }),
    );
    expect(
      requests.every(
        (request) => request.modelId === modelId && request.maxOutputTokens !== undefined,
      ),
    ).toBe(true);
    for (const phase of ["coordinator", "report", "synthesis"]) {
      const stages = requests.filter((request) => phaseOf(request) === phase);
      expect(stages.length).toBeGreaterThan(0);
      for (const request of stages) {
        const messages = request.prompt.content;
        expect(messages.at(-2)?.role).toBe("assistant");
        expect(JSON.stringify(messages.at(-2))).toContain(
          phase === "report" ? "Registered sources" : "Research plan (data)",
        );
        expect(messages.at(-1)?.role).toBe("user");
        expect(JSON.stringify(messages.at(-1))).toContain("data, not instructions");
      }
    }
    const workers = requests.filter((request) => phaseOf(request) === "worker");
    expect(
      workers.every(
        (request) => Object.keys(request.toolkit!.tools).sort().join(",") === "read_url,web_search",
      ),
    ).toBe(true);
    for (const worker of workers) {
      const prompt = JSON.stringify(worker.prompt);
      expect(
        prompt.includes("Investigate evidence for the user's question") &&
          prompt.includes("Independently investigate disagreements"),
      ).toBe(false);
    }
  });

  it("lets workers and the coordinator finish on evidence with most of the budget unspent", async () => {
    finishWorkersEarly = true;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    const calls = await runtime.runPromise(
      ChatRepo.use((repo) => repo.listToolCalls([sent.assistantMessageId])),
    );
    expect(calls.filter((call) => call.toolName === "web_search")).toHaveLength(2);
    expect(requests.filter((request) => phaseOf(request) === "worker")).toHaveLength(4);
    expect(requests.filter((request) => phaseOf(request) === "coordinator")).toHaveLength(2);
    expect(requests.filter((request) => phaseOf(request) === "report")).toHaveLength(2);
    expect(requests.filter((request) => phaseOf(request) === "synthesis")).toHaveLength(1);
    const promptFor = (phase: string) =>
      JSON.stringify(requests.find((request) => phaseOf(request) === phase)!.prompt);
    expect(promptFor("planning")).toContain("completion criteria");
    expect(promptFor("worker")).toContain("not a fixed source count");
    expect(promptFor("report")).toContain(
      "Distinguish gaps that could materially change the answer from optional detail",
    );
    expect(promptFor("coordinator")).toContain("even with most of the budget left");
    expect(promptFor("synthesis")).not.toContain("search/read ceiling");
  });

  it("captures the stored search cap once and applies admin changes to the next retry", async () => {
    await runtime.runPromise(
      ToolsRepo.use((repo) =>
        repo.updateTool("web_search", {
          config: { researchMaxSearchQueries: 12 },
        }),
      ),
    );
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const gate = {
      phase: "planning",
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
        repo.updateTool("web_search", {
          config: { researchMaxSearchQueries: 24 },
        }),
      ),
    );
    expect(patched?.config).toMatchObject({ backend: "searxng", researchMaxSearchQueries: 24 });
    hold = null;
    await runtime.runPromise(Deferred.succeed(gate.release, undefined));
    await remote.runPromise(collect(sent.assistantMessageId));
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
    await remote.runPromise(collect(sent.assistantMessageId));
    expect(backendSearches).toBe(24);
    const retryCoordinator = requests.find((request) => phaseOf(request) === "coordinator")!;
    expect(JSON.stringify(retryCoordinator.prompt.content.at(-1))).toContain("about 24 searches");
    expect(requests.filter((request) => phaseOf(request) === "synthesis")).toHaveLength(1);
    // A later unrelated patch must preserve the saved cap.
    const toggled = await runtime.runPromise(
      ToolsRepo.use((repo) => repo.updateTool("web_search", { enabled: false })),
    );
    expect(toggled?.config.researchMaxSearchQueries).toBe(24);
  });

  it("persists remote Stop, interrupts provider work, fences stale Stop and retries with a fresh run", async () => {
    const input = await runtime.runPromise(seed);
    hold = {
      phase: "planning",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
    };
    const gate = hold;
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(Deferred.await(gate.reached));
    const message = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
    ))!;
    const stale = await remote.runPromise(
      ChatService.use((service) =>
        service.stopGeneration({ ...input, messageId: message.id, researchRunId: "old-run" }),
      ),
    );
    expect(stale.stopped).toBe(false);
    const stopped = await remote.runPromise(
      ChatService.use((service) =>
        service.stopGeneration({
          ...input,
          messageId: message.id,
          researchRunId: message.researchRunId!,
        }),
      ),
    );
    expect(stopped.stopped).toBe(true);
    await runtime.runPromise(
      Deferred.await(gate.interrupted).pipe(Effect.timeout(Duration.seconds(5))),
    );
    await remote.runPromise(collect(message.id, message.researchRunId!));
    expect(requests.some((request) => phaseOf(request) === "synthesis")).toBe(false);
    hold = null;
    await runtime.runPromise(
      ChatService.use((service) => service.retryMessage({ ...input, messageId: message.id })),
    );
    await remote.runPromise(collect(message.id));
    const retried = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(message.id)),
    ))!;
    expect(retried.researchRunId).not.toBe(message.researchRunId);
    expect(retried.generationMode).toBe("research");
    const oldStream = await remote.runPromise(collect(message.id, message.researchRunId!));
    expect(oldStream).toHaveLength(1);
    expect(oldStream[0]).toMatchObject({ kind: "done", runId: retried.researchRunId });
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const ledger = yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.messageId, message.id));
        expect(ledger).toHaveLength(2);
        expect(ledger.some((row) => !row.usageComplete && row.cost === null)).toBe(true);
      }),
    );
  });

  it("enforces one active attempt per user without blocking ordinary chats", async () => {
    const input = await runtime.runPromise(seed);
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const other = yield* repo.createConversation({ userId: input.userId, modelId });
        const first = yield* repo.createTurn({
          ...input,
          modelId,
          generationMode: "research",
          content: "first",
          attachmentIds: [],
        });
        const failed = yield* Effect.exit(
          repo.createTurn({
            userId: input.userId,
            conversationId: other.id,
            modelId,
            generationMode: "research",
            content: "second",
            attachmentIds: [],
          }),
        );
        expect(failed._tag).toBe("Failure");
        expect(yield* repo.listMessages(other.id)).toHaveLength(0);
        expect(
          (yield* repo.createTurn({
            userId: input.userId,
            conversationId: other.id,
            modelId,
            content: "ordinary",
            attachmentIds: [],
          })).assistant.generationMode,
        ).toBe("chat");
        expect(
          yield* repo.research!.cancel(first.assistant.id, first.assistant.researchRunId!),
        ).toBe(true);
        expect((yield* repo.getMessage(first.assistant.id))?.status).toBe("aborted");
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
          ...input,
          modelId,
          generationMode: "research",
          content: "first",
          attachmentIds: [],
        });
        const claimed = (yield* repo.research!.claim(turn.assistant.researchRunId!))!;
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
        expect((yield* repo.getMessage(turn.assistant.id))?.status).toBe("streaming");
        yield* db
          .update(researchRuns)
          .set({ leaseUntil: sql`now() - interval '1 second'` })
          .where(eq(researchRuns.id, claimed.run.id));
        yield* Effect.all([repo.research!.reap(), repo.research!.reap()], { concurrency: 2 });
        expect((yield* repo.getMessage(turn.assistant.id))?.content).toBe(
          "Retained partial report",
        );
        expect((yield* repo.research!.get(claimed.run.id))?.progress.phase).toBe("interrupted");
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
        expect(
          yield* db.select().from(usageEvents).where(eq(usageEvents.id, claimed.run.id)),
        ).toHaveLength(1);
        expect((yield* repo.listToolCalls([turn.assistant.id]))[0]?.toolName).toBe("deep_research");
      }),
    );
  });

  it("discards an unsolicited clarification answer from both live and durable final prose", async () => {
    const input = await runtime.runPromise(seed);
    clarificationProse = "I cannot browse live sources. Here is a generic answer instead. ".repeat(
      100,
    );
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    const events = await remote.runPromise(collect(sent.assistantMessageId));
    const liveText = events
      .flatMap((event) =>
        event.kind === "chunk" && event.chunkKind === "text" ? [event.delta] : [],
      )
      .join("");
    expect(liveText).toContain("Supported conclusion");
    expect(liveText).not.toContain("cannot browse");
    expect(liveText).not.toContain("generic answer");
    const message = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
    ))!;
    expect(message.content).toBe(liveText);
    expect(message.status).toBe("complete");
    expect(requests.some((request) => phaseOf(request) === "worker")).toBe(true);
  });

  it.each([
    ["provider", "A research provider request failed (InvalidRequestError; HTTP 400)."],
    ["context", "The provider rejected the research context size."],
    ["defect", "Research stopped because of an execution failure."],
  ] as const)(
    "preserves safe %s failure diagnostics instead of falsely claiming an exploration deadline",
    async (failure, diagnostic) => {
      const input = await runtime.runPromise(seed);
      coordinatorFailure = failure;
      clarificationProse = "PRIVATE_CLARIFICATION_ANSWER";
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      const events = await remote.runPromise(collect(sent.assistantMessageId));
      expect(
        events.filter((event) => event.kind === "chunk" && event.chunkKind === "text"),
      ).toHaveLength(0);
      expect(
        requests.some(
          (request) => phaseOf(request) === "worker" || phaseOf(request) === "synthesis",
        ),
      ).toBe(false);
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          expect(message.status).toBe("error");
          expect(message.content).toBe("");
          const run = (yield* repo.research!.get(message.researchRunId!))!;
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
          expect(JSON.stringify(root.result)).toContain(diagnostic);
          expect(JSON.stringify({ message, progress: run.progress, root, events })).not.toMatch(
            /PRIVATE_PROVIDER_PAYLOAD|authorization=secret|PRIVATE_CLARIFICATION_ANSWER/,
          );
        }),
      );
    },
  );

  it("inherits research only for validated structured answers and skips", async () => {
    const input = await runtime.runPromise(seed);
    clarify = true;
    const first = await runtime.runPromise(send(input.userId, input.conversationId));
    const events = await remote.runPromise(collect(first.assistantMessageId));
    expect(
      events.filter((event) => event.kind === "chunk" && event.chunkKind === "text"),
    ).toHaveLength(0);
    const tools = events.flatMap((event) =>
      event.kind === "chunk" && event.chunkKind === "tool" ? [JSON.parse(event.delta)] : [],
    );
    expect(tools).toContainEqual(
      expect.objectContaining({ family: "ask", phase: "start", textOffset: 0 }),
    );
    expect(tools).toContainEqual(
      expect.objectContaining({
        family: "ask",
        phase: "result",
        result: expect.objectContaining({ outcome: "presented" }),
      }),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const message = (yield* repo.getMessage(first.assistantMessageId))!;
        expect((yield* repo.research!.get(message.researchRunId!))?.progress.phase).toBe(
          "awaiting_answer",
        );
        const call = (yield* repo.listToolCalls([message.id])).find(
          (row) => row.toolName === "ask_user",
        )!;
        expect(message.content).toBe("");
        expect(call.textOffset).toBe(0);
        const turn = yield* repo.createTurn({
          ...input,
          modelId,
          attachmentIds: [],
          questionResponse: { callId: call.id, response: { kind: "skip" } },
        });
        expect(turn.userMessage.generationMode).toBe("research");
        expect(turn.assistant.generationMode).toBe("research");
        yield* repo.research!.cancel(turn.assistant.id, turn.assistant.researchRunId!);
        const ordinary = yield* repo.createTurn({
          ...input,
          modelId,
          attachmentIds: [],
          content: "ordinary followup",
        });
        expect(ordinary.userMessage.generationMode).toBe("chat");
        yield* db
          .update(messages)
          .set({ status: "complete" })
          .where(
            and(
              eq(messages.conversationId, input.conversationId),
              eq(messages.status, "streaming"),
            ),
          );
      }),
    );
  });
  it("keeps a report that was cut short instead of failing the whole run", async () => {
    synthesisCutShort = true;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        expect(message.content).toContain("Supported conclusion[^1]");
        const run = yield* repo.research!.get(message.researchRunId!);
        expect(run?.progress.phase).toBe("partial");
        expect(run?.progress.limitations).toContain("The final report was cut short.");
      }),
    );
  });

  it("stops exploring once the search backend is down instead of spending every round on it", async () => {
    searchDown = true;
    queriesPerSearch = 3;
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
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
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        const run = yield* repo.research!.get(message.researchRunId!);
        expect(run?.progress.limitations).toContain(
          "Web search was unavailable, so most of the investigation could not run.",
        );
        const synthesis = requests.find((request) => phaseOf(request) === "synthesis");
        expect(JSON.stringify(synthesis?.prompt ?? "")).toContain(
          "web search service was unavailable",
        );
      }),
    );
  });

  it("tells workers and the coordinator what is left, and tightens as it runs out", async () => {
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    const noticeOf = (request: GatewayInput) => JSON.stringify(request.prompt.content.at(-1) ?? "");
    const workers = requests.filter((request) => phaseOf(request) === "worker");
    const coordinators = requests.filter((request) => phaseOf(request) === "coordinator");
    // Every exploring turn ends on a user-role budget line — never an assistant
    // prefill — and states what remains.
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

  it("budgets every dispatch wave and actual call while preserving synthesis", async () => {
    dispatchWaves = RESEARCH_LIMITS.coordinatorRounds;
    // The tool's own per-call maximum, so exploration meets the search ceiling.
    queriesPerSearch = 3;
    const input = await runtime.runPromise(seed);
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(sent.assistantMessageId));
    // Exploration stops when the web budget is gone rather than spending the
    // remaining model calls on tools that can only refuse.
    expect(requests.length).toBeLessThanOrEqual(RESEARCH_LIMITS.calls);
    const synthesis = requests.filter((request) => phaseOf(request) === "synthesis");
    expect(synthesis).toHaveLength(1);
    // Not surfaced as a limitation, but the answer still has to disclose it.
    expect(JSON.stringify(synthesis[0]!.prompt)).toContain("search/read ceiling");
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const message = (yield* repo.getMessage(sent.assistantMessageId))!;
        expect(message.status).toBe("complete");
        const calls = yield* db
          .select()
          .from(researchCalls)
          .where(eq(researchCalls.runId, message.researchRunId!));
        expect(calls).toHaveLength(requests.length);
        const tasks = yield* db
          .select()
          .from(researchTasks)
          .where(eq(researchTasks.runId, message.researchRunId!));
        expect(tasks.length).toBeLessThanOrEqual(RESEARCH_LIMITS.tasks);
        const webCalls = (yield* repo.listToolCalls([message.id])).filter(
          (call) => call.toolName === "web_search",
        );
        // The final batch can complete with two admitted queries and one
        // refusal: completed tool calls times batch size would incorrectly say 81.
        // Count backend execution to pin the exact 80-query ceiling, including
        // its partial final batch, rather than rounding down to 78.
        expect(backendSearches).toBe(RESEARCH_LIMITS.searches);
        // At most the batch in flight when the ceiling was reached, not a
        // cascade of refusals across every remaining round.
        expect(webCalls.filter((call) => call.status === "error").length).toBeLessThanOrEqual(
          RESEARCH_LIMITS.workers,
        );
        const run = yield* repo.research!.get(message.researchRunId!);
        // Spending the budget is the design, not a defect worth reporting.
        expect(run?.progress.limitations.some((l) => /search|page read/.test(l))).toBe(false);
        expect(run?.progress.limitations).not.toContain(
          "A coordinator round dispatched no useful tasks.",
        );
      }),
    );
  });

  it.each(["planning", "coordinator", "synthesis"])(
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
      overflowPhase = phase;
      const sent = await runtime.runPromise(send(input.userId, input.conversationId));
      await remote.runPromise(collect(sent.assistantMessageId));
      const attempts = requests.filter((request) => phaseOf(request) === phase);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(attempts[1]!.prompt).length).toBeLessThan(
        JSON.stringify(attempts[0]!.prompt).length,
      );
      expect(JSON.stringify(attempts[1]!.prompt)).toContain("Investigate the evidence.");
      for (const request of attempts) {
        expect(request.prompt.content.at(-1)?.role).toBe("user");
        expect(JSON.stringify(request.prompt.content.at(-1))).toContain("data, not instructions");
        if (phase !== "planning") {
          expect(request.prompt.content.at(-2)?.role).toBe("assistant");
          expect(JSON.stringify(request.prompt.content.at(-2))).toContain("Research plan (data)");
        }
      }
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const repo = yield* ChatRepo;
          const message = (yield* repo.getMessage(sent.assistantMessageId))!;
          expect(message.status).toBe("complete");
          const calls = yield* db
            .select()
            .from(researchCalls)
            .where(eq(researchCalls.runId, message.researchRunId!));
          expect(calls).toHaveLength(requests.length);
          const ledger = yield* db
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.messageId, message.id));
          expect(ledger[0]!.inputTokens).toBe((requests.length - 1) * 100);
          expect(ledger[0]!.usageComplete).toBe(false);
        }),
      );
    },
  );

  it("checkpoints active research usage before conversation deletion and interrupts its owner", async () => {
    const input = await runtime.runPromise(seed);
    hold = {
      phase: "report",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
    };
    const gate = hold;
    const sent = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(
      Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(10))),
    );
    const message = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
    ))!;
    await remote.runPromise(ChatService.use((service) => service.deleteConversation(input)));
    await runtime.runPromise(
      Deferred.await(gate.interrupted).pipe(Effect.timeout(Duration.seconds(5))),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        expect(yield* repo.getMessage(message.id)).toBeNull();
        expect(
          yield* db.select().from(researchRuns).where(eq(researchRuns.id, message.researchRunId!)),
        ).toHaveLength(0);
        expect(
          yield* db
            .select()
            .from(researchCalls)
            .where(eq(researchCalls.runId, message.researchRunId!)),
        ).toHaveLength(0);
        const ledger = yield* db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.id, message.researchRunId!));
        expect(ledger).toHaveLength(1);
        expect(ledger[0]!.inputTokens).toBeGreaterThan(0);
        expect(ledger[0]!.usageComplete).toBe(false);
        expect(ledger[0]!.status).toBe("aborted");
        expect(ledger[0]!.conversationId).toBe(input.conversationId);
        expect(ledger[0]!.messageId).toBe(message.id);
        yield* repo.research!.reap();
        expect(
          yield* db.select().from(usageEvents).where(eq(usageEvents.id, message.researchRunId!)),
        ).toHaveLength(1);
      }),
    );
  });

  it("retains stopped research source numbers in a subsequent research attempt", async () => {
    const input = await runtime.runPromise(seed);
    hold = {
      phase: "report",
      reached: Deferred.makeUnsafe<void>(),
      interrupted: Deferred.makeUnsafe<void>(),
    };
    const gate = hold;
    const first = await runtime.runPromise(send(input.userId, input.conversationId));
    await runtime.runPromise(
      Deferred.await(gate.reached).pipe(Effect.timeout(Duration.seconds(10))),
    );
    const firstMessage = (await runtime.runPromise(
      ChatRepo.use((repo) => repo.getMessage(first.assistantMessageId)),
    ))!;
    await remote.runPromise(
      ChatService.use((service) =>
        service.stopGeneration({
          ...input,
          messageId: firstMessage.id,
          researchRunId: firstMessage.researchRunId!,
        }),
      ),
    );
    await remote.runPromise(collect(firstMessage.id, firstMessage.researchRunId!));
    expect(
      (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(firstMessage.id))))?.status,
    ).toBe("aborted");
    hold = null;
    requests.length = 0;
    coordinatorTurns = 0;
    evidenceUrl = "https://evidence.example/followup";
    const second = await runtime.runPromise(send(input.userId, input.conversationId));
    await remote.runPromise(collect(second.assistantMessageId));
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
    // Citation identity survives, but unrelated inherited evidence is not injected into every worker.
    expect(JSON.stringify(worker.prompt)).not.toContain("https://evidence.example/source");
  });

  it.each(["worker", "report", "synthesis"])(
    "Stop during %s interrupts the scoped provider and begins no further invocation",
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
      const message = (await runtime.runPromise(
        ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
      ))!;
      await remote.runPromise(
        ChatService.use((service) =>
          service.stopGeneration({
            ...input,
            messageId: message.id,
            researchRunId: message.researchRunId!,
          }),
        ),
      );
      await runtime.runPromise(
        Deferred.await(gate.interrupted).pipe(Effect.timeout(Duration.seconds(5))),
      );
      const countAtInterruption = requests.length;
      await remote.runPromise(collect(message.id, message.researchRunId!));
      expect(requests).toHaveLength(countAtInterruption);
      expect(
        (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(message.id))))?.status,
      ).toBe("aborted");
    },
  );
});
