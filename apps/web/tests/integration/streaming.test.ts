import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { uuidv7 } from "uuidv7";
import { Response as AiResponse, type Prompt } from "effect/unstable/ai";
import { eq, sql } from "drizzle-orm";
import {
  attachmentBlobs,
  attachments,
  messageAttachments,
  messageChunks,
  messages,
  models,
  skills,
  skillRevisions,
  usageEvents,
} from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { EMPTY_AGENT_DRAFT } from "~/modules/agents/draft-schema.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { loadConversationDetail } from "~/modules/chat/server/conversation-detail.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { hermesToolCalls } from "~/modules/providers/server/hermes-tools.ts";
import { askUserTool } from "~/modules/tools/server/ask-user.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { FakeDocumentParser, FakeWebSearch, FakeUrlReader } from "./unused-services.ts";
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
let runtime: ManagedRuntime.ManagedRuntime<
  | AgentRepo
  | AgentDraftService
  | ChatRepo
  | ChatService
  | StreamEngine
  | SyncBus
  | Db
  | AttachmentRepo
  | AttachmentService
  | ExternalCompletion,
  unknown
>;
/** messages.model_id is a real FK; retry resolves the row behind it. */
let visionModelId: string;
let textModelId: string;
let imageModelId: string;
const generatedPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
// Complete 1×1 RGB PNGs with distinct pixels, CRCs and compressed image data.
const editedPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);
let nextGeneratedImage: Uint8Array | undefined;
let terminalFixtures: ChatStreamPart[][] | undefined;
const generatedBlobs = new Map<string, Uint8Array>();
const ImageBlobStore = Layer.succeed(BlobStore, {
  put: (key, bytes) =>
    Effect.sync(() => {
      generatedBlobs.set(key, bytes);
    }),
  get: (key) =>
    generatedBlobs.has(key)
      ? Effect.succeed(generatedBlobs.get(key)!)
      : Effect.die("Missing test blob"),
  delete: (key) =>
    Effect.sync(() => {
      generatedBlobs.delete(key);
    }),
  exists: (key) => Effect.succeed(generatedBlobs.has(key)),
  deletePrefix: () => Effect.void,
});

// Set by a test that needs to act on a generation while it is mid-stream: the
// fake provider signals `reached` once it has emitted `after` parts and then
// parks on `release`, so "stop it now" has a deterministic now.
let hold: {
  after: number;
  reached: Deferred.Deferred<void>;
  release: Deferred.Deferred<void>;
} | null = null;

const streamPrompts: Array<Prompt.Prompt> = [];
type GatewayInput = Parameters<AiGateway["Service"]["streamChat"]>[0];
let authoringScript:
  | ((input: GatewayInput) => ReturnType<AiGateway["Service"]["streamChat"]>)
  | null = null;
const authoringFinish = (reason: "stop" | "tool-calls" = "stop") =>
  AiResponse.makePart("finish", {
    reason,
    usage: new AiResponse.Usage({ inputTokens: { total: 100 }, outputTokens: { total: 10 } }),
  });
const authoringTool = (input: GatewayInput, name: string, params: unknown, hermes = false) => {
  const id = uuidv7();
  const calls = hermes
    ? hermesToolCalls(
        Stream.make(
          AiResponse.makePart("text-delta", {
            id: "t",
            delta: `<tool_call>${JSON.stringify({ name, arguments: params })}</tool_call>`,
          }),
          authoringFinish(),
        ),
        { tools: Object.values(input.toolkit!.tools), nextId: Effect.succeed(id) },
      )
    : Stream.make(
        AiResponse.makePart("tool-call", { id, name, params, providerExecuted: false }),
        authoringFinish("tool-calls"),
      );
  return calls.pipe(
    Stream.flatMap((part): Stream.Stream<ChatStreamPart, never, unknown> =>
      part.type === "tool-call"
        ? Stream.make(part).pipe(
            Stream.concat(
              Stream.unwrap(
                input.toolkit!.handle(name, part.params, part.id).pipe(Effect.orDie),
              ).pipe(
                Stream.orDie,
                Stream.map((result) =>
                  AiResponse.toolResultPart({
                    id: part.id,
                    name,
                    providerExecuted: false,
                    ...result,
                  }),
                ),
              ),
            ),
          )
        : Stream.make(part),
    ),
  ) as Stream.Stream<ChatStreamPart>;
};

// Deterministic fake AI provider: streams 5 words with a small delay.
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
  // Titles are not exercised here; the stream engine never calls this.
  generateText: () => Effect.die("no title generation in these tests"),
  streamChat: (input) =>
    Stream.suspend(() => {
      streamPrompts.push(input.prompt);
      if (authoringScript) return authoringScript(input);
      if (terminalFixtures) {
        const parts = terminalFixtures.shift();
        if (!parts) return Stream.die("Unexpected extra provider call");
        return Stream.fromIterable(parts);
      }
      if (input.modelId === imageModelId) {
        expect(input.imageOutput).toBe(true);
        return Stream.fromIterable([
          AiResponse.makePart("text-delta", { id: "image-text", delta: "Before" }),
          AiResponse.makePart("file", {
            mediaType: "image/png",
            data: nextGeneratedImage ?? generatedPng,
          }),
          AiResponse.makePart("text-delta", { id: "image-text", delta: "After" }),
          AiResponse.makePart("finish", {
            reason: "stop",
            usage: new AiResponse.Usage({ inputTokens: { total: 12 }, outputTokens: { total: 4 } }),
            metadata: {
              openrouter: {
                reasoningDetails: [
                  { type: "reasoning.encrypted", data: "private-replay", id: "opaque" },
                ],
                usage: { cost: 0.04, prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
              },
            },
          }),
        ]);
      }
      let emitted = 0;
      return Stream.fromIterable(["alpha ", "beta ", "gamma ", "delta ", "epsilon"]).pipe(
        Stream.map((delta): ChatStreamPart => ({ type: "text-delta", id: "t", delta }) as never),
        Stream.tap(() =>
          Effect.suspend(() => {
            emitted += 1;
            const gate = hold;
            if (!gate || emitted < gate.after) return Effect.sleep("30 millis");
            return Deferred.succeed(gate.reached, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            );
          }),
        ),
        Stream.concat(
          Stream.make({
            type: "finish",
            reason: "stop",
            usage: { inputTokens: {}, outputTokens: {} },
          } as never as ChatStreamPart),
        ),
      );
    }),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const PgLive = PgClient.layer({ url: Redacted.make(url), maxConnections: 5 });
  const InfraLayer = Db.layer.pipe(Layer.provideMerge(PgLive));
  // ChatRepo reconciles attachment claims, so AttachmentRepo sits under it.
  const ReposLayer = Layer.mergeAll(
    AnalyticsRepo.layer,
    AgentRepo.layer,
    ChatRepo.layer,
    KnowledgeRepo.layer,
    ProviderRepo.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(InfraLayer),
  );
  const EngineCore = Layer.mergeAll(
    FakeGateway,
    FakeKnowledge,
    FakeWebSearch,
    FakeUrlReader,
    ImageBlobStore,
    FakeDocumentParser,
    FakeMemoryService,
    ExternalCompletion.layer,
    SyncBus.layer,
  ).pipe(Layer.provideMerge(ReposLayer));
  const EngineLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(AttachmentService.layer.pipe(Layer.provideMerge(EngineCore))),
  );
  const AppLayer = ChatService.layer.pipe(Layer.provideMerge(EngineLayer));
  runtime = ManagedRuntime.make(AppLayer);

  imageModelId = uuidv7();
  visionModelId = uuidv7();
  textModelId = uuidv7();
  const providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, kind, base_url, api_key_ciphertext)
         values ('${providerId}', 'p', 'openrouter', 'http://x', 'x')` as never,
      );
      yield* db.insert(models).values([
        {
          id: imageModelId,
          providerId,
          modelKey: "image-model",
          displayName: "Image output",
          type: "chat",
          capabilities: {
            reasoning: false,
            tools: true,
            vision: true,
            files: false,
            imageOutput: true,
          },
        },
        {
          id: visionModelId,
          providerId,
          modelKey: "sees",
          displayName: "Sees Images",
          type: "chat",
          capabilities: { reasoning: false, tools: false, vision: true, files: false },
        },
        {
          id: textModelId,
          providerId,
          modelKey: "text",
          displayName: "Text Only",
          type: "chat",
          capabilities: { reasoning: false, tools: false, vision: false, files: false },
        },
      ]);
    }),
  );
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
  const userMessage = yield* repo.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hi",
  });
  const assistant = yield* repo.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    status: "streaming",
  });
  return { userId, conversation, userMessage, assistant };
});

const questionParams = {
  questions: [
    {
      question: "Choose the response style",
      options: [{ label: "Concise" }, { label: "Detailed", description: "With examples" }],
      multiSelect: false,
    },
  ],
};
const setupQuestion = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const seed = yield* setupConversation;
  yield* repo.finalizeMessage({ messageId: seed.assistant.id, status: "complete", content: "" });
  const callId = uuidv7();
  yield* repo.insertToolCall({
    id: callId,
    messageId: seed.assistant.id,
    turnIndex: 0,
    callIndex: 0,
    textOffset: 0,
    providerCallId: "ask-1",
    toolName: "ask_user",
    arguments: questionParams,
  });
  yield* repo.completeToolCall({
    id: callId,
    status: "complete",
    result: { v: 1, outcome: "presented", ...questionParams },
  });
  return { ...seed, callId, expectedMessages: yield* repo.listMessages(seed.conversation.id) };
});
const answerInput = (seed: Effect.Success<typeof setupQuestion>) => ({
  userId: seed.userId,
  conversationId: seed.conversation.id,
  modelId: textModelId,
  attachmentIds: [],
  questionResponse: {
    callId: seed.callId,
    response: { kind: "answers" as const, answers: [{ selected: [1], custom: "" }] },
  },
});
const retryInput = (seed: Effect.Success<typeof setupQuestion>) => ({
  userId: seed.userId,
  messageId: seed.assistant.id,
  modelId: textModelId,
  expectedMessages: seed.expectedMessages,
  deleteMessageIds: [],
  invalidateCheckpointThroughMessageIds: [],
});

describe("conversational agent authoring", () => {
  const ordinaryChat = Effect.gen(function* () {
    const seed = yield* setupConversation;
    const conversation = yield* (yield* ChatRepo).createConversation({
      userId: seed.userId,
      modelId: textModelId,
    });
    return { ...seed, conversation };
  });
  const reply = () =>
    Stream.make(
      AiResponse.makePart("text-delta", { id: "t", delta: "The draft is ready to review." }),
      authoringFinish(),
    );
  const collectDraftTurn = (id: string) =>
    runtime.runPromise(
      Effect.flatMap(StreamEngine, (engine) => Stream.runCollect(engine.subscribe(id, 0))),
    );
  it.each([false, true])(
    "opens and edits a private draft in ordinary chat (Hermes: %s), not its target",
    async (hermes) => {
      const seed = await runtime.runPromise(ordinaryChat);
      const targetId = await runtime.runPromise(
        AgentRepo.use((repo) =>
          repo.create(seed.userId, {
            ...EMPTY_AGENT_DRAFT,
            name: "Original agent",
            instructions: "PRIVATE_TARGET_PERSONA",
          }),
        ),
      );
      const prompts: GatewayInput[] = [];
      authoringScript = (input) => {
        prompts.push(input);
        if (prompts.length === 1)
          return authoringTool(input, "draft_agent", { agentId: targetId }, hermes);
        if (prompts.length === 2)
          return authoringTool(
            input,
            "update_agent_draft",
            { expectedRevision: "bad", changes: { name: "Wrong" } },
            hermes,
          ).pipe(
            Stream.filter((part) => part.type !== "finish"),
            Stream.concat(authoringTool(input, "list_agent_options", { kind: "models" }, hermes)),
          );
        if (prompts.length === 3)
          return authoringTool(
            input,
            "update_agent_draft",
            {
              expectedRevision: 1,
              changes: {
                name: "Draft agent",
                instructions: "PRIVATE_DRAFT_BODY",
              },
            },
            hermes,
          );
        if (prompts.length === 4)
          return authoringTool(
            input,
            "draft_agent",
            { agentId: targetId, changes: { instructions: "PRIVATE_STALE_PROPOSAL" } },
            hermes,
          );
        return reply();
      };
      try {
        expect(
          await runtime.runPromise(
            AgentDraftService.use((service) =>
              service
                .list(seed.userId, seed.conversation.id)
                .pipe(Effect.map((drafts) => drafts[0] ?? null)),
            ),
          ),
        ).toBeNull();
        const { conversationId, assistantMessageId } = await runtime.runPromise(
          ChatService.use((service) =>
            service.sendMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              modelId: textModelId,
              content: "Help me edit this agent.",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
        await collectDraftTurn(assistantMessageId);
        expect(prompts).toHaveLength(5);
        expect(JSON.stringify(prompts[0]!.prompt)).not.toContain("PRIVATE_TARGET_PERSONA");
        expect(JSON.stringify(prompts[1]!.prompt)).toContain("PRIVATE_TARGET_PERSONA");
        expect(JSON.stringify(prompts[4]!.prompt)).toContain("PRIVATE_DRAFT_BODY");
        expect(JSON.stringify(prompts[4]!.prompt)).not.toContain("PRIVATE_STALE_PROPOSAL");
        const draft = await runtime.runPromise(
          AgentDraftService.use((service) =>
            service
              .list(seed.userId, conversationId)
              .pipe(Effect.map((drafts) => drafts[0] ?? null)),
          ),
        );
        expect(draft).toMatchObject({
          revision: 2,
          settings: { name: "Draft agent", instructions: "PRIVATE_DRAFT_BODY" },
        });
        expect(
          (await runtime.runPromise(AgentRepo.use((repo) => repo.get(seed.userId, targetId))))?.row,
        ).toMatchObject({
          name: "Original agent",
          instructions: "PRIVATE_TARGET_PERSONA",
          configRevision: 1,
        });
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        expect(detail.agentDrafts.map((draft) => draft.id)).toEqual([draft!.id]);
        expect(detail.agent).toBeNull();
        expect(detail.messages).toHaveLength(2);
        expect(detail.messages.at(-1)?.status).toBe("complete");
        expect(detail.toolCalls.map((call) => call.arguments)).toEqual([{}, {}, {}, {}, {}]);
        const rejected = detail.toolCalls.find(
          (call) => call.result && (call.result as { outcome?: string }).outcome === "invalid",
        )!;
        expect(rejected.error?.code).toBe("AgentDraftNotUpdated");
        expect(rejected.error?.message).toContain("expectedRevision");
        expect(rejected.error?.message).not.toContain("Wrong");
        expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
        const chunks = await runtime.runPromise(
          ChatRepo.use((repo) => repo.chunksAfter(assistantMessageId, 0)),
        );
        expect(JSON.stringify(chunks)).not.toContain("PRIVATE_");
        expect(chunks.some((chunk) => chunk.delta.includes('"family":"agent-draft"'))).toBe(true);
        expect(
          chunks.some((chunk) =>
            chunk.delta.includes('"reason":"Provide the current expectedRevision'),
          ),
        ).toBe(true);
        // Branch before retry erases the original activities, so this proves actual
        // historical widget copying rather than merely the absence of a live draft.
        const branch = await runtime.runPromise(
          ChatService.use((service) =>
            service.branchConversation({
              userId: seed.userId,
              conversationId,
              messageId: assistantMessageId,
            }),
          ),
        );
        const branched = await runtime.runPromise(
          loadConversationDetail(seed.userId, branch.conversationId),
        );
        expect(branched.agentDrafts).toEqual([]);
        expect(branched.toolCalls).toHaveLength(5);
        expect(branched.toolCalls[0]!.result).toMatchObject({
          outcome: "drafted",
          draftConversationId: conversationId,
        });
        expect(
          await runtime.runPromise(
            AgentDraftService.use((service) =>
              service
                .list(seed.userId, branch.conversationId)
                .pipe(Effect.map((drafts) => drafts[0] ?? null)),
            ),
          ),
        ).toBeNull();
        expect(JSON.stringify(branched)).not.toContain("PRIVATE_");
        expect(
          await runtime.runPromise(
            AgentDraftService.use((service) =>
              service.save(seed.userId, { draftId: draft!.id, expectedRevision: draft!.revision }),
            ),
          ),
        ).toMatchObject({ outcome: "saved", agentId: targetId, configRevision: 2 });
        await runtime.runPromise(
          AgentDraftService.use((service) =>
            service.patch(seed.userId, {
              draftId: draft!.id,
              expectedRevision: draft!.revision,
              changes: { instructions: "PRIVATE_LATER_DRAFT" },
            }),
          ),
        );
        authoringScript = (input) => {
          expect(JSON.stringify(input.prompt)).toContain("PRIVATE_LATER_DRAFT");
          return reply();
        };
        await runtime.runPromise(
          ChatService.use((service) =>
            service.retryMessage({
              userId: seed.userId,
              conversationId,
              messageId: assistantMessageId,
            }),
          ),
        );
        await collectDraftTurn(assistantMessageId);
        const retried = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        expect(retried.toolCalls).toHaveLength(0);
        expect(retried.agentDrafts).toHaveLength(1);
        const sent = await runtime.runPromise(
          ChatService.use((service) =>
            service.sendMessage({
              userId: seed.userId,
              conversationId,
              modelId: textModelId,
              content: "Keep working with my changes.",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
        await collectDraftTurn(sent.assistantMessageId);
        const edited = await runtime.runPromise(
          ChatService.use((service) =>
            service.editMessage({
              userId: seed.userId,
              conversationId,
              messageId: detail.messages[0]!.id,
              modelId: textModelId,
              content: "Let’s refine the agent.",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
        await collectDraftTurn(edited.assistantMessageId);
      } finally {
        authoringScript = null;
      }
    },
  );

  it.each([false, true])(
    "refreshes and budgets a direct edit before the next provider call (small context: %s)",
    async (small) => {
      const seed = await runtime.runPromise(ordinaryChat);
      const [model] = await runtime.runPromise(
        Db.use((db) => db.select().from(models).where(eq(models.id, textModelId))),
      );
      if (small)
        await runtime.runPromise(
          Db.use((db) =>
            db.update(models).set({ contextLength: 8000 }).where(eq(models.id, textModelId)),
          ),
        );
      let calls = 0;
      const instructions = small ? "x".repeat(20000) : "PRIVATE_DIRECT_EDIT";
      authoringScript = (input) => {
        calls++;
        if (calls > 1) {
          expect(JSON.stringify(input.prompt)).toContain(instructions);
          return reply();
        }
        // Resolved when it runs, not when it is built: the draft only exists
        // once draft_agent below has executed.
        const directEdit = Effect.promise(() =>
          runtime.runPromise(
            AgentDraftService.use((service) =>
              service.list(seed.userId, seed.conversation.id).pipe(
                Effect.flatMap((drafts) =>
                  service.patch(seed.userId, {
                    draftId: drafts[0]!.id,
                    expectedRevision: 1,
                    changes: { instructions },
                  }),
                ),
              ),
            ),
          ),
        );
        return authoringTool(input, "draft_agent", { changes: { name: "Working draft" } }).pipe(
          Stream.map((part) =>
            part.type === "finish"
              ? AiResponse.makePart("finish", {
                  reason: "tool-calls",
                  usage: new AiResponse.Usage({
                    inputTokens: { total: estimatePromptTokens(input.prompt.content) },
                    outputTokens: { total: 10 },
                  }),
                })
              : part,
          ),
          Stream.concat(Stream.fromEffectDrain(directEdit)),
        );
      };
      try {
        const sent = await runtime.runPromise(
          ChatService.use((service) =>
            service.sendMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              modelId: textModelId,
              content: "Prepare an agent.",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        );
        await collectDraftTurn(sent.assistantMessageId);
        expect(calls).toBe(small ? 1 : 2);
        expect(
          await runtime.runPromise(
            ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
          ),
        ).toMatchObject({ status: small ? "error" : "complete" });
        expect(
          await runtime.runPromise(
            AgentDraftService.use((service) =>
              service
                .list(seed.userId, seed.conversation.id)
                .pipe(Effect.map((drafts) => drafts[0] ?? null)),
            ),
          ),
        ).toMatchObject({ revision: 2, settings: { instructions } });
      } finally {
        authoringScript = null;
        await runtime.runPromise(
          Db.use((db) =>
            db
              .update(models)
              .set({ contextLength: model!.contextLength })
              .where(eq(models.id, textModelId)),
          ),
        );
      }
    },
  );

  it("uses the current draft when answering a structured clarification", async () => {
    const seed = await runtime.runPromise(setupQuestion);
    const opened = await runtime.runPromise(
      AgentDraftService.use((service) =>
        service.open(
          seed.userId,
          {
            conversationId: seed.conversation.id,
            changes: { name: "Before clarification" },
          },
          () => Effect.void,
        ),
      ),
    );
    await runtime.runPromise(
      AgentDraftService.use((service) =>
        service.patch(seed.userId, {
          draftId: opened.draft.id,
          expectedRevision: opened.draft.revision,
          changes: { instructions: "PRIVATE_CLARIFIED_DRAFT" },
        }),
      ),
    );
    let calls = 0;
    authoringScript = (input) => {
      calls++;
      expect(JSON.stringify(input.prompt)).toContain("PRIVATE_CLARIFIED_DRAFT");
      return reply();
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({ ...answerInput(seed), searchEnabled: false }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      expect(calls).toBe(1);
      expect(
        (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId))))
          ?.status,
      ).toBe("complete");
    } finally {
      authoringScript = null;
    }
  });

  it("lists the user's models beside the draft and accepts a singular option kind", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    authoringScript = (input) => {
      round++;
      const prompt = JSON.stringify(input.prompt);
      if (round === 1) {
        expect(prompt).not.toContain("availableModels");
        expect(prompt).not.toContain("Text Only");
        return authoringTool(input, "draft_agent", { changes: { name: "Model picker" } });
      }
      if (round === 2) {
        // The data block is JSON inside a text part, so its quotes arrive escaped.
        const escaped = (value: unknown) => JSON.stringify(JSON.stringify(value)).slice(1, -1);
        expect(prompt).toContain(escaped({ id: textModelId, name: "Text Only", current: true }));
        return authoringTool(input, "list_agent_options", { kind: "Model" });
      }
      return reply();
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Use Claude as the preferred model.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      expect(round).toBe(3);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(
        detail.toolCalls.map((call) => [call.status, (call.result as { outcome: string }).outcome]),
      ).toEqual([
        ["complete", "drafted"],
        ["complete", "options"],
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("offers manual-only skill metadata without opening a draft or exposing it in activity", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const id = uuidv7();
    await runtime.runPromise(
      Db.use((db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(skills).values({
              id,
              userId: seed.userId,
              name: "PRIVATE_MANUAL_SKILL",
              description: "PRIVATE_SKILL_DESCRIPTION",
              manualOnly: true,
            });
            yield* tx.insert(skillRevisions).values({
              id: uuidv7(),
              skillId: id,
              revision: 1,
              name: "PRIVATE_MANUAL_SKILL",
              description: "PRIVATE_SKILL_DESCRIPTION",
              manualOnly: true,
              contentHash: "fixture",
            });
          }),
        ),
      ),
    );
    let calls = 0;
    authoringScript = (input) => {
      if (++calls === 1) {
        expect(JSON.stringify(input.prompt)).not.toContain("PRIVATE_MANUAL_SKILL");
        return authoringTool(input, "list_agent_options", {
          kind: "skills",
          query: "PRIVATE_MANUAL",
        });
      }
      expect(JSON.stringify(input.prompt)).toContain("PRIVATE_MANUAL_SKILL");
      expect(JSON.stringify(input.prompt)).toContain(id);
      return reply();
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Find a skill for a future agent.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      expect(calls).toBe(2);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.agentDrafts).toEqual([]);
      expect(detail.toolCalls).toHaveLength(1);
      expect(detail.toolCalls[0]!.result).toEqual({ outcome: "options" });
      expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
    } finally {
      authoringScript = null;
    }
  });

  it("accepts null placeholders and numeric strings the way models write them", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    authoringScript = (input) => {
      round++;
      if (round === 1)
        return authoringTool(input, "draft_agent", {
          agentId: null,
          changes: {
            title: "Jira helper",
            description: null,
            model: null,
            conversationStarters: ["Write a bug report"],
            systemPrompt: "Be precise.",
          },
        });
      if (round === 2)
        return authoringTool(input, "update_agent_draft", {
          expectedRevision: "1",
          changes: { instructions: "Write clear tickets.", icon: null },
        });
      return reply();
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Make a Jira agent.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      expect(round).toBe(3);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      const draft = await runtime.runPromise(
        AgentDraftService.use((service) =>
          service
            .list(seed.userId, seed.conversation.id)
            .pipe(Effect.map((drafts) => drafts[0] ?? null)),
        ),
      );
      // Both rows point at the one draft the tools actually wrote.
      expect(detail.toolCalls.map((call) => call.result)).toEqual([
        {
          outcome: "drafted",
          revision: 1,
          draftId: draft!.id,
          draftConversationId: seed.conversation.id,
        },
        {
          outcome: "updated",
          revision: 2,
          changedFields: ["instructions"],
          draftId: draft!.id,
          draftConversationId: seed.conversation.id,
        },
      ]);
      expect(draft).toMatchObject({
        revision: 2,
        settings: {
          name: "Jira helper",
          description: "",
          modelId: null,
          starters: ["Write a bug report"],
          instructions: "Write clear tickets.",
          icon: "robot",
        },
      });
    } finally {
      authoringScript = null;
    }
  });

  it("prepares a second agent in its own draft instead of overwriting the first", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    // Two separate sends: the tool loop would otherwise run every round inside
    // the first generation, before the first draft is saved.
    let turn: "first" | "second" = "first";
    let round = 0;
    authoringScript = (input) => {
      round++;
      if (turn === "second")
        return round === 1
          ? authoringTool(input, "draft_agent", { changes: { name: "Release notes" } })
          : reply();
      if (round === 1) return authoringTool(input, "draft_agent", { changes: { name: "Tickets" } });
      if (round === 2)
        return authoringTool(input, "update_agent_draft", {
          expectedRevision: 1,
          changes: { instructions: "PRIVATE_FIRST" },
        });
      return reply();
    };
    try {
      const first = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Make a ticket agent.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(first.assistantMessageId);
      const drafts = Effect.flatMap(AgentDraftService, (service) =>
        service.list(seed.userId, seed.conversation.id),
      );
      const started = await runtime.runPromise(drafts);
      expect(started).toHaveLength(1);
      const saved = await runtime.runPromise(
        AgentDraftService.use((service) =>
          service.save(seed.userId, {
            draftId: started[0]!.id,
            expectedRevision: started[0]!.revision,
          }),
        ),
      );
      if (saved.outcome !== "saved") throw new Error("expected saved");
      turn = "second";
      round = 0;
      const second = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Now make a release notes agent.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(second.assistantMessageId);
      const both = await runtime.runPromise(drafts);
      expect(both).toHaveLength(2);
      // The saved agent keeps the first draft's settings; the second is separate.
      expect(both.find((draft) => draft.targetAgentId === saved.agentId)).toMatchObject({
        settings: { name: "Tickets", instructions: "PRIVATE_FIRST" },
      });
      expect(both.find((draft) => draft.targetAgentId === null)).toMatchObject({
        settings: { name: "Release notes", instructions: "" },
      });
      expect(
        (await runtime.runPromise(AgentRepo.use((repo) => repo.get(seed.userId, saved.agentId))))!
          .row,
      ).toMatchObject({ name: "Tickets", configRevision: 1 });
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.agentDrafts.map((draft) => draft.name).sort()).toEqual([
        "Release notes",
        "Tickets",
      ]);
      expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
    } finally {
      authoringScript = null;
    }
  });

  it("names both drafts when an update omits the id, and patches the right one when given it", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    // The id comes from the trailing draft data in the prompt, which is how a
    // real model learns it.
    const idOf = (input: GatewayInput, name: string) => {
      const block = input.prompt.content
        .flatMap((message) => {
          const content: unknown = message.content;
          return typeof content === "string"
            ? [content]
            : (content as Array<{ text?: string }>).map((part) => part.text ?? "");
        })
        .find((text) => text.startsWith("Application-provided agent draft"));
      const data = JSON.parse(block!.slice(block!.indexOf("\n") + 1)) as {
        draft: { draftId: string; name: string } | null;
        otherDrafts: ReadonlyArray<{ draftId: string; name: string }>;
      };
      return [...(data.draft ? [data.draft] : []), ...data.otherDrafts].find(
        (draft) => draft.name === name,
      )!.draftId;
    };
    authoringScript = (input) => {
      round++;
      // Four tool rounds is the ceiling; the fifth call has no toolkit.
      if (round === 1)
        return authoringTool(input, "draft_agent", {
          changes: { name: "Alpha", instructions: "Alpha body" },
        });
      if (round === 2) return authoringTool(input, "draft_agent", { changes: { name: "Beta" } });
      // Ambiguous: two drafts and no id.
      if (round === 3)
        return authoringTool(input, "update_agent_draft", {
          expectedRevision: 1,
          changes: { instructions: "Which one?" },
        });
      if (round === 4)
        return authoringTool(input, "update_agent_draft", {
          draftId: idOf(input, "Beta"),
          expectedRevision: 1,
          changes: { instructions: "Beta body" },
        });
      return reply();
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Make two agents.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      const drafts = await runtime.runPromise(
        AgentDraftService.use((service) => service.list(seed.userId, seed.conversation.id)),
      );
      // Addressed by id, the patch lands on Beta and leaves Alpha alone.
      expect(drafts.find((draft) => draft.settings.name === "Beta")!.settings.instructions).toBe(
        "Beta body",
      );
      expect(drafts.find((draft) => draft.settings.name === "Alpha")!.settings.instructions).toBe(
        "Alpha body",
      );
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      const ambiguous = detail.toolCalls.find(
        (call) => (call.result as { outcome?: string }).outcome === "invalid",
      )!;
      expect(ambiguous.error?.code).toBe("AgentDraftNotUpdated");
      expect(ambiguous.error?.message).toContain("draftId is required");
      expect(ambiguous.error?.message).toContain("Alpha");
      expect(ambiguous.error?.message).toContain("Beta");
      // The reason is for debugging only; the transcript never carries it.
      expect(JSON.stringify(detail.toolCalls.map((call) => call.result))).not.toContain(
        "draftId is required",
      );
    } finally {
      authoringScript = null;
    }
  });

  it("refuses unavailable edit targets without turning an ordinary chat into a builder session", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    authoringScript = (input) =>
      ++round === 1 ? authoringTool(input, "draft_agent", { agentId: uuidv7() }) : reply();
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Edit this unavailable agent.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(sent.assistantMessageId);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.agentDrafts).toEqual([]);
      expect(detail.messages.at(-1)?.status).toBe("complete");
      expect(detail.toolCalls[0]!.result).toEqual({ outcome: "unavailable" });
      expect(detail.toolCalls[0]!.error).toEqual({
        code: "AgentDraftNotUpdated",
        message: "That agent is not available to edit.",
      });
    } finally {
      authoringScript = null;
    }
  });
});

describe("structured answer persistence and edits", () => {
  it.each(["existing assistant", "missing assistant"])(
    "edits answers through the %s path",
    async (path) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const service = yield* ChatService;
          const engine = yield* StreamEngine;
          const seed = yield* setupQuestion;
          const turn = yield* repo.createTurn(answerInput(seed));
          yield* repo.finalizeMessage({
            messageId: turn.assistant.id,
            status: "complete",
            content: "Old answer",
          });
          if (path === "missing assistant") yield* repo.deleteMessages([turn.assistant.id]);
          const originalCalls = yield* repo.listToolCalls([seed.assistant.id]);
          const input = {
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: turn.userMessage.id,
            modelId: textModelId,
            searchEnabled: false,
            attachmentIds: [],
          };
          const ordinary = yield* service
            .editMessage({ ...input, content: "unrelated text" })
            .pipe(Effect.flip);
          const invalid = yield* service
            .editMessage({
              ...input,
              questionResponse: { kind: "answers", answers: [{ selected: [3], custom: "" }] },
            })
            .pipe(Effect.flip);
          const response = {
            kind: "answers" as const,
            answers: [{ selected: [], custom: "My own style" }],
          };
          const edited = yield* service.editMessage({ ...input, questionResponse: response });
          yield* engine.subscribe(edited.assistantMessageId, 0).pipe(Stream.runCollect);
          const answer = yield* repo.getMessage(turn.userMessage.id);
          const branch = yield* repo.cloneConversationPrefix({
            userId: seed.userId,
            sourceConversationId: seed.conversation.id,
            throughMessageId: edited.assistantMessageId,
          });
          const branchMessages = yield* repo.listMessages(branch.id);
          const calls = yield* repo.listToolCalls(branchMessages.map((message) => message.id));
          return {
            ordinary,
            invalid,
            response,
            answer,
            originalCalls,
            afterCalls: yield* repo.listToolCalls([seed.assistant.id]),
            branchMessages,
            calls,
            chunks: yield* repo.chunksAfter(branchMessages.at(-1)!.id, 0),
          };
        }),
      );
      expect(result.ordinary).toMatchObject({ _tag: "InvalidMessage" });
      expect(result.invalid).toMatchObject({ _tag: "InvalidMessage" });
      expect(result.answer).toMatchObject({
        content: "Q1: My own style",
        questionResponse: { v: 1, response: result.response },
      });
      expect(result.afterCalls).toEqual(result.originalCalls);
      expect(result.branchMessages[2]).toMatchObject({
        content: result.answer!.content,
        questionResponse: result.answer!.questionResponse,
      });
      expect(result.calls[0]).toMatchObject({ textOffset: 0 });
      expect(result.calls[0]!.id).not.toBe(result.originalCalls[0]!.id);
      expect(result.chunks).toEqual([]);
    },
  );

  it("rejects a stale history snapshot even when changed answer metadata has identical text", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const seed = yield* setupQuestion;
        const turn = yield* repo.createTurn(answerInput(seed));
        yield* repo.finalizeMessage({
          messageId: turn.assistant.id,
          status: "complete",
          content: "Answer",
        });
        const expectedMessages = yield* repo.listMessages(seed.conversation.id);
        yield* db
          .update(messages)
          .set({
            questionResponse: {
              v: 1,
              response: { kind: "answers", answers: [{ selected: [], custom: "Detailed" }] },
            },
          })
          .where(eq(messages.id, turn.userMessage.id));
        return yield* repo.resetMessageForRetry({
          userId: seed.userId,
          messageId: turn.assistant.id,
          modelId: textModelId,
          expectedMessages,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
        });
      }),
    );
    expect(result.claimed).toBe(false);
  });

  it("clears unsupported metadata when a fallback message is edited normally", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const seed = yield* setupQuestion;
        const turn = yield* repo.createTurn(answerInput(seed));
        yield* repo.finalizeMessage({
          messageId: turn.assistant.id,
          status: "complete",
          content: "Answer",
        });
        yield* db
          .update(messages)
          .set({ questionResponse: { v: 99 } })
          .where(eq(messages.id, turn.userMessage.id));
        yield* repo.resetMessageForRetry({
          userId: seed.userId,
          messageId: turn.assistant.id,
          modelId: textModelId,
          expectedMessages: yield* repo.listMessages(seed.conversation.id),
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
          edit: {
            messageId: turn.userMessage.id,
            conversationId: seed.conversation.id,
            content: "Ordinary answer",
            attachmentIds: [],
          },
        });
        return yield* repo.getMessage(turn.userMessage.id);
      }),
    );
    expect(result).toMatchObject({ content: "Ordinary answer", questionResponse: null });
  });
});

describe("atomic question answers", () => {
  it("accepts one of two concurrent answers and leaves the original result immutable", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupQuestion;
        const before = yield* repo.listToolCalls([seed.assistant.id]);
        const outcomes = yield* Effect.all(
          [0, 1].map(() =>
            repo.createTurn(answerInput(seed)).pipe(
              Effect.map(() => "accepted"),
              Effect.catchTag("ConversationBusy", () => Effect.succeed("ConversationBusy")),
            ),
          ),
          { concurrency: "unbounded" },
        );
        return {
          outcomes,
          before,
          after: yield* repo.listToolCalls([seed.assistant.id]),
          messages: yield* repo.listMessages(seed.conversation.id),
        };
      }),
    );
    expect(result.outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(1);
    expect(result.outcomes).toContain("ConversationBusy");
    expect(result.messages).toHaveLength(4);
    expect(result.messages[2]).toMatchObject({
      content: "Q1: Detailed",
      questionResponse: {
        v: 1,
        response: { kind: "answers", answers: [{ selected: [1], custom: "" }] },
      },
    });
    expect(result.after).toEqual(result.before);
  });

  it.each(["normal send", "retry", "edit"])(
    "serializes an answer racing with %s",
    async (action) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const seed = yield* setupQuestion;
          const competing =
            action === "normal send"
              ? repo
                  .createTurn({
                    userId: seed.userId,
                    conversationId: seed.conversation.id,
                    modelId: textModelId,
                    content: "ordinary reply",
                    attachmentIds: [],
                  })
                  .pipe(
                    Effect.map(() => true),
                    Effect.catch(() => Effect.succeed(false)),
                  )
              : repo
                  .resetMessageForRetry({
                    ...retryInput(seed),
                    ...(action === "edit"
                      ? {
                          edit: {
                            messageId: seed.userMessage.id,
                            conversationId: seed.conversation.id,
                            content: "edited",
                            attachmentIds: [],
                          },
                        }
                      : {}),
                  })
                  .pipe(Effect.map((value) => value.claimed));
          const outcomes = yield* Effect.all(
            [
              repo.createTurn(answerInput(seed)).pipe(
                Effect.map(() => true),
                Effect.catch(() => Effect.succeed(false)),
              ),
              competing,
            ],
            { concurrency: "unbounded" },
          );
          return { outcomes, messages: yield* repo.listMessages(seed.conversation.id) };
        }),
      );
      expect(result.outcomes.filter(Boolean)).toHaveLength(1);
      expect(result.messages.filter((message) => message.status === "streaming")).toHaveLength(1);
    },
  );

  it("rejects a stale rewind snapshot even after a new answer has finished", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupQuestion;
        const turn = yield* repo.createTurn(answerInput(seed));
        yield* repo.finalizeMessage({
          messageId: turn.assistant.id,
          status: "complete",
          content: "new answer",
        });
        const rewind = yield* repo.resetMessageForRetry(retryInput(seed));
        const edit = yield* repo.createAssistantForEdit({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          userMessageId: seed.userMessage.id,
          expectedEditedAt: null,
          expectedMessages: seed.expectedMessages,
          content: "stale edit",
          attachmentIds: [],
          modelId: textModelId,
          deleteMessageIds: [seed.assistant.id],
          invalidateCheckpointThroughMessageIds: [],
        });
        return { rewind, edit, messages: yield* repo.listMessages(seed.conversation.id) };
      }),
    );
    expect(result.rewind.claimed).toBe(false);
    expect(result.edit).toBeNull();
    expect(result.messages.map((message) => message.content)).toEqual([
      "hi",
      "",
      "Q1: Detailed",
      "new answer",
    ]);
  });

  it.each([
    "invalid selection",
    "foreign call",
    "foreign user",
    "stale tail",
    "retried",
    "error",
    "aborted",
    "streaming",
  ])("refuses %s without writing a turn", async (scenario) => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupQuestion;
        const input = answerInput(seed);
        if (scenario === "invalid selection")
          input.questionResponse.response.answers[0]!.selected = [3];
        if (scenario === "foreign call")
          input.questionResponse.callId = (yield* setupQuestion).callId;
        if (scenario === "foreign user") input.userId = (yield* setupQuestion).userId;
        if (scenario === "stale tail")
          yield* repo.insertMessage({
            conversationId: seed.conversation.id,
            role: "user",
            content: "replied elsewhere",
          });
        if (scenario === "retried") {
          yield* repo.resetMessageForRetry(retryInput(seed));
          yield* repo.finalizeMessage({
            messageId: seed.assistant.id,
            status: "complete",
            content: "replacement",
          });
        }
        if (scenario === "error" || scenario === "aborted")
          yield* repo.finalizeMessage({
            messageId: seed.assistant.id,
            status: scenario,
            content: "",
          });
        if (scenario === "streaming")
          yield* repo.insertMessage({
            conversationId: seed.conversation.id,
            role: "assistant",
            status: "streaming",
          });
        const before = yield* repo.listMessages(seed.conversation.id);
        const error = yield* repo.createTurn(input).pipe(Effect.flip);
        return { before, after: yield* repo.listMessages(seed.conversation.id), error };
      }),
    );
    expect(result.after).toEqual(result.before);
    expect(result.error).toMatchObject({
      _tag:
        scenario === "invalid selection"
          ? "InvalidMessage"
          : scenario === "foreign user"
            ? "ConversationNotFound"
            : scenario === "streaming"
              ? "ConversationBusy"
              : "QuestionUnavailable",
    });
  });

  it("branches with fresh card identity and answers each branch independently", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupQuestion;
        const branch = yield* repo.cloneConversationPrefix({
          userId: seed.userId,
          sourceConversationId: seed.conversation.id,
          throughMessageId: seed.assistant.id,
        });
        const branchMessages = yield* repo.listMessages(branch.id);
        const calls = yield* repo.listToolCalls(branchMessages.map((message) => message.id));
        const sourceTurn = yield* repo.createTurn(answerInput(seed));
        const branchTurn = yield* repo.createTurn({
          ...answerInput(seed),
          conversationId: branch.id,
          questionResponse: { callId: calls[0]!.id, response: { kind: "skip" } },
        });
        return { originalId: seed.callId, calls, sourceTurn, branchTurn };
      }),
    );
    expect(result.calls[0]?.id).not.toBe(result.originalId);
    expect(result.sourceTurn.userMessage.content).toBe("Q1: Detailed");
    expect(result.branchTurn.userMessage.content).toContain("skipping is not approval");
    expect(result.branchTurn.userMessage.questionResponse).toEqual({
      v: 1,
      response: { kind: "skip" },
    });
    expect(result.sourceTurn.conversation.id).not.toBe(result.branchTurn.conversation.id);
  });

  it("validates the selected model before answering and starts the ordinary next generation", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const service = yield* ChatService;
        const engine = yield* StreamEngine;
        const seed = yield* setupQuestion;
        const unknown = yield* service
          .sendMessage({ ...answerInput(seed), modelId: uuidv7(), searchEnabled: false })
          .pipe(Effect.flip);
        const before = yield* repo.listMessages(seed.conversation.id);
        const reply = yield* service.sendMessage({
          ...answerInput(seed),
          modelId: visionModelId,
          searchEnabled: false,
          timeZone: "Europe/Berlin",
        });
        yield* engine.subscribe(reply.assistantMessageId, 0).pipe(Stream.runCollect);
        const old = yield* repo.createTurn(answerInput(seed)).pipe(Effect.flip);
        return {
          unknown,
          before,
          reply,
          old,
          messages: yield* repo.listMessages(seed.conversation.id),
        };
      }),
    );
    expect(result.unknown).toMatchObject({ _tag: "ModelNotFound" });
    expect(result.before).toHaveLength(2);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toMatchObject({
      id: result.reply.assistantMessageId,
      modelId: visionModelId,
      status: "complete",
    });
    expect(result.old).toMatchObject({ _tag: "QuestionUnavailable" });
    expect(JSON.stringify(streamPrompts.at(-1))).toContain("Choose the response style");
  });
});

// A finished exchange whose answer came from `originalModelId`: the state
// the retry menu acts on.
const seedAnswered = (originalModelId: string) =>
  Effect.gen(function* () {
    const repo = yield* ChatRepo;
    const db = yield* Db;
    const userId = uuidv7();
    yield* db.execute(
      `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
    );
    const conversation = yield* repo.createConversation({ userId, modelId: originalModelId });
    const userMessage = yield* repo.insertMessage({
      conversationId: conversation.id,
      role: "user",
      content: "hi",
    });
    const assistant = yield* repo.insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      status: "streaming",
      modelId: originalModelId,
    });
    yield* repo.finalizeMessage({
      messageId: assistant.id,
      status: "complete",
      content: "first answer",
    });
    return { userId, conversation, userMessage, assistant };
  });

describe("resumable streaming pipeline", () => {
  it("persists chunks, finalizes the message, and replays for late subscribers", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* setupConversation;

        yield* engine.startGeneration({
          generationId: assistant.generationId ?? undefined,
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

  it("stops a generation early, keeping the partial answer", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* setupConversation;

        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 3, reached, release };

        yield* engine.startGeneration({
          generationId: assistant.generationId ?? undefined,
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
          searchEnabled: false,
        });

        // Subscribed before the stop so the terminal event is observed live,
        // not replayed from an already-finalized row.
        const events = yield* Effect.forkChild(
          engine.subscribe(assistant.id, 0).pipe(Stream.runCollect),
        );

        yield* Deferred.await(reached);
        const stopped = yield* engine.stopGeneration(
          assistant.id,
          assistant.generationId ?? undefined,
        );
        const collected = Array.from(yield* Fiber.join(events));

        const final = yield* repo.getMessage(assistant.id);
        const chunks = yield* repo.chunksAfter(assistant.id, 0);
        // Nothing should still be parked on it, but leaving a live deferred
        // behind would wedge the next test's generation.
        yield* Deferred.interrupt(release);
        hold = null;

        return { stopped, collected, final, chunks };
      }),
    );

    expect(result.stopped).toBe(true);
    expect(result.collected.at(-1)).toMatchObject({ kind: "done", status: "aborted" });
    expect(result.final?.status).toBe("aborted");
    // Whatever the model produced before the stop is kept, and only that.
    expect(result.final?.content).not.toBe("");
    expect("alpha beta gamma delta epsilon".startsWith(result.final?.content ?? "")).toBe(true);
    expect(result.final?.content).not.toBe("alpha beta gamma delta epsilon");
    // Contiguous from seq 1 and exactly the persisted content — resume relies
    // on both, and the stop path has its own flush.
    expect(result.chunks.map((c) => c.seq)).toEqual(result.chunks.map((_, index) => index + 1));
    expect(result.chunks.map((c) => c.delta).join("")).toBe(result.final?.content);
  }, 60_000);

  it("settles a generation whose process died and lets the reader stop or resend", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const { userId, conversation, assistant } = yield* setupConversation;
        // A crashed process left chunks, a running tool row and a lapsed lease
        // behind. Nothing is registered in this engine, exactly as after a restart.
        yield* db.insert(messageChunks).values([
          { messageId: assistant.id, seq: 1, kind: "text", delta: "partial " },
          { messageId: assistant.id, seq: 2, kind: "reasoning", delta: "thinking" },
          { messageId: assistant.id, seq: 3, kind: "text", delta: "answer" },
        ]);
        yield* repo.insertToolCall({
          id: uuidv7(),
          messageId: assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "orphan",
          toolName: "web_search",
          arguments: {},
        });
        // Fresh lease: still considered alive, so nothing may settle it yet.
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() + interval '1 minute'` })
          .where(eq(messages.id, assistant.id));
        yield* engine.reapOrphans;
        const stillLive = yield* repo.getMessage(assistant.id);
        const busy = yield* repo
          .createTurn({
            userId,
            conversationId: conversation.id,
            modelId: textModelId,
            content: "again",
            attachmentIds: [],
          })
          .pipe(Effect.flip);
        // Lease lapsed: the process is gone. A subscriber that arrives now must
        // not hang on a live tail that can never end.
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(messages.id, assistant.id));
        const events = yield* engine
          .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
          .pipe(Stream.runCollect, Effect.timeout("5 seconds"));
        const stopped = yield* chat.stopGeneration({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          generationId: assistant.generationId ?? undefined,
        });
        const settled = yield* repo.getMessage(assistant.id);
        const toolCalls = yield* repo.listToolCalls([assistant.id]);
        const next = yield* repo.createTurn({
          userId,
          conversationId: conversation.id,
          modelId: textModelId,
          content: "again",
          attachmentIds: [],
        });
        return {
          stillLive,
          busy: busy._tag,
          events: Array.from(events),
          stopped,
          settled,
          toolCalls,
          next,
        };
      }),
    );
    expect(result.stillLive?.status).toBe("streaming");
    expect(result.busy).toBe("ConversationBusy");
    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "error" });
    expect(result.events.filter((event) => event.kind === "chunk")).toHaveLength(3);
    expect(result.stopped).toEqual({ stopped: false });
    expect(result.settled).toMatchObject({
      status: "error",
      content: "partial answer",
      reasoning: "thinking",
      error: {
        tag: "GenerationFailed",
        message: "The response was interrupted before it finished.",
      },
    });
    expect(result.toolCalls[0]).toMatchObject({
      status: "error",
      error: { code: "GenerationFailed" },
    });
    expect(result.next.assistant.status).toBe("streaming");
  }, 60_000);

  it("grants a retry of an old row a fresh lease instead of reaping it at once", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const { userId, conversation, assistant } = yield* seedAnswered(textModelId);
        // An answer from long ago: any fallback on the row's creation time
        // would call the new attempt lapsed before it streamed a byte.
        yield* db
          .update(messages)
          .set({
            createdAt: sql`clock_timestamp() - interval '2 hours'`,
            generationLeaseUntil: null,
          })
          .where(eq(messages.id, assistant.id));
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 2, reached, release };
        yield* chat.retryMessage({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
        });
        yield* Deferred.await(reached);
        yield* engine.reapOrphans;
        const during = yield* repo.getMessage(assistant.id);
        yield* Deferred.succeed(release, undefined);
        hold = null;
        const collected = yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);
        return {
          during,
          final: yield* repo.getMessage(assistant.id),
          last: Array.from(collected).at(-1),
        };
      }),
    );
    expect(result.during?.status).toBe("streaming");
    expect(result.last).toMatchObject({ kind: "done", status: "complete" });
    expect(result.final).toMatchObject({
      status: "complete",
      content: "alpha beta gamma delta epsilon",
    });
  }, 60_000);

  it("renews the lease while a generation is alive and never reaps it", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const { userId, conversation, assistant } = yield* setupConversation;
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 3, reached, release };
        yield* engine.startGeneration({
          generationId: assistant.generationId ?? undefined,
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
          searchEnabled: false,
        });
        yield* Deferred.await(reached);
        // Wait for the buffered chunks to land first: while any remain, a
        // non-empty flush would renew the lease and the assertion below would
        // hold even with the heartbeat gone.
        yield* Effect.repeat(
          // Delayed so the flusher fiber actually gets to run between attempts.
          repo.chunksAfter(assistant.id, 0).pipe(Effect.delay(Duration.millis(10))),
          // `hold.after` blocks inside the tap, so that chunk never reaches the
          // buffer: two land, not three.
          { until: (rows) => rows.length === 2 },
        );
        // Held mid-stream with nothing left to write, so only the empty-batch
        // heartbeat can move this lease back into the future.
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 hour'` })
          .where(eq(messages.id, assistant.id));
        yield* Effect.repeat(
          db
            .select({ lease: messages.generationLeaseUntil })
            .from(messages)
            .where(eq(messages.id, assistant.id))
            .pipe(Effect.delay(Duration.millis(10))),
          { until: (rows) => (rows[0]?.lease?.getTime() ?? 0) > Date.now() },
        );
        yield* engine.reapOrphans;
        const during = yield* repo.getMessage(assistant.id);
        yield* Deferred.succeed(release, undefined);
        hold = null;
        const collected = yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);
        return { during, last: Array.from(collected).at(-1) };
      }),
    );
    expect(result.during?.status).toBe("streaming");
    expect(result.last).toMatchObject({ kind: "done", status: "complete" });
  }, 60_000);

  it("reports nothing to stop for a message that is not generating here", async () => {
    const stopped = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        return yield* engine.stopGeneration(uuidv7());
      }),
    );
    expect(stopped).toBe(false);
  });

  it("refuses a new turn while a generation is still streaming", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* setupConversation;

        const turn = (content: string) =>
          repo.createTurn({
            userId,
            conversationId: conversation.id,
            modelId: null as never,
            content,
            attachmentIds: [],
          });

        // The seeded assistant is still streaming — same rule as retry/edit.
        const busy = yield* turn("second tab").pipe(Effect.flip);
        const messagesAfterBusy = (yield* repo.listMessages(conversation.id)).length;

        yield* repo.finalizeMessage({
          messageId: assistant.id,
          status: "complete",
          content: "done",
        });
        const afterFinish = yield* turn("follow-up");

        return {
          busy: busy._tag,
          messagesAfterBusy,
          followUpStatus: afterFinish.assistant.status,
        };
      }),
    );

    expect(result.busy).toBe("ConversationBusy");
    // The refused turn wrote nothing — just the seeded user + assistant.
    expect(result.messagesAfterBusy).toBe(2);
    expect(result.followUpStatus).toBe("streaming");
  });

  it("atomically claims an assistant restart and applies its edit", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { userId, conversation, userMessage, assistant } = yield* setupConversation;
        yield* repo.finalizeMessage({
          messageId: assistant.id,
          status: "complete",
          content: "old response",
        });
        yield* repo.appendChunks(assistant.id, [{ seq: 1, kind: "text", delta: "old" }]);
        const later = yield* repo.insertMessage({
          conversationId: conversation.id,
          role: "user",
          content: "later turn",
        });

        const restart = {
          expectedMessages: yield* repo.listMessages(conversation.id),
          userId,
          messageId: assistant.id,
          modelId: null as never,
          deleteMessageIds: [later.id],
          edit: {
            messageId: userMessage.id,
            conversationId: conversation.id,
            content: "edited prompt",
            attachmentIds: [],
          },
          invalidateCheckpointThroughMessageIds: [],
        };
        const firstClaim = yield* repo.resetMessageForRetry(restart);
        const secondClaim = yield* repo.resetMessageForRetry(restart);

        return {
          firstClaim,
          secondClaim,
          user: yield* repo.getMessage(userMessage.id),
          assistant: yield* repo.getMessage(assistant.id),
          later: yield* repo.getMessage(later.id),
          chunks: yield* repo.chunksAfter(assistant.id, 0),
        };
      }),
    );

    expect(result.firstClaim.claimed).toBe(true);
    expect(result.secondClaim.claimed).toBe(false);
    expect(result.user?.content).toBe("edited prompt");
    expect(result.user?.editedAt).toBeInstanceOf(Date);
    expect(result.assistant).toMatchObject({ status: "streaming", content: "" });
    expect(result.later).toBeNull();
    expect(result.chunks).toEqual([]);
  });

  it("atomically edits and creates a missing assistant response", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { userId, conversation, userMessage, assistant } = yield* setupConversation;
        yield* repo.deleteMessages([assistant.id]);
        const later = yield* repo.insertMessage({
          conversationId: conversation.id,
          role: "user",
          content: "later turn",
        });

        const edit = {
          expectedMessages: yield* repo.listMessages(conversation.id),
          userId,
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          expectedEditedAt: userMessage.editedAt,
          content: "edited prompt",
          attachmentIds: [],
          modelId: null as never,
          deleteMessageIds: [later.id],
          invalidateCheckpointThroughMessageIds: [],
        };
        const created = yield* repo.createAssistantForEdit(edit);
        const secondClaim = yield* repo.createAssistantForEdit(edit);

        return {
          created,
          secondClaim,
          originalCreatedAt: userMessage.createdAt,
          user: yield* repo.getMessage(userMessage.id),
          later: yield* repo.getMessage(later.id),
          messages: yield* repo.listMessages(conversation.id),
        };
      }),
    );

    expect(result.created?.message).toMatchObject({ role: "assistant", status: "streaming" });
    expect(result.secondClaim).toBeNull();
    expect(result.user?.content).toBe("edited prompt");
    expect(result.user?.editedAt).toBeInstanceOf(Date);
    expect(result.user?.createdAt).toEqual(result.originalCreatedAt);
    expect(result.later).toBeNull();
    expect(result.messages.map((message) => message.id)).toEqual([
      result.user?.id,
      result.created?.message.id,
    ]);
  });

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

describe("retry with a different model", () => {
  // Rows only: the guard under test runs before any blob is read, so the
  // stubbed store never has to hold bytes.
  const attachImage = (userId: string, messageId: string) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const blobId = uuidv7();
      const attachmentId = uuidv7();
      yield* db.insert(attachmentBlobs).values({
        id: blobId,
        userId,
        sha256: blobId,
        storageKey: `test/${blobId}`,
        size: 4,
        mediaType: "image/png",
      });
      yield* db
        .insert(attachments)
        .values({ id: attachmentId, userId, blobId, fileName: "shot.png" });
      yield* db.insert(messageAttachments).values({ messageId, attachmentId, position: 0 });
    });

  it("refreshes late runtime context on send, retry and edit without rewriting history", async () => {
    streamPrompts.length = 0;
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation } = yield* seedAnswered(textModelId);
        const sent = yield* chat.sendMessage({
          userId,
          conversationId: conversation.id,
          modelId: textModelId,
          content: "What day is it?",
          searchEnabled: false,
          attachmentIds: [],
          timeZone: "Europe/Berlin",
        });
        yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
        yield* chat.retryMessage({
          userId,
          conversationId: conversation.id,
          messageId: sent.assistantMessageId,
          timeZone: "America/Los_Angeles",
        });
        yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
        const history = yield* repo.listMessages(conversation.id);
        const question = history.find((message) => message.content === "What day is it?")!;
        const edited = yield* chat.editMessage({
          userId,
          conversationId: conversation.id,
          messageId: question.id,
          modelId: textModelId,
          content: "What time is it?",
          searchEnabled: false,
          attachmentIds: [],
          timeZone: "Asia/Tokyo",
        });
        yield* engine.subscribe(edited.assistantMessageId, 0).pipe(Stream.runDrain);
        return yield* repo.listMessages(conversation.id);
      }),
    );

    expect(streamPrompts).toHaveLength(3);
    const snapshots = streamPrompts.map((prompt, index) => {
      const clocks = prompt.content.filter((message) =>
        JSON.stringify(message).includes("<runtime-context>"),
      );
      expect(clocks).toHaveLength(1);
      const clock = clocks[0]!;
      expect(clock.role).toBe("user");
      expect(prompt.content.at(-1)).toBe(clock);
      const text = JSON.stringify(clock);
      expect(text).toContain(
        `Time zone: ${["Europe/Berlin", "America/Los_Angeles", "Asia/Tokyo"][index]}`,
      );
      return text.match(/UTC instant: ([0-9T:.Z-]+)/)?.[1];
    });
    expect(snapshots.every((snapshot) => snapshot !== undefined)).toBe(true);
    expect(new Set(snapshots).size).toBe(3);
    // Retrying in a different zone changes only the final runtime block.
    expect(streamPrompts[1]!.content.slice(0, -1)).toEqual(streamPrompts[0]!.content.slice(0, -1));
    // Editing changes the latest user turn, not the earlier UTC-annotated history.
    expect(streamPrompts[2]!.content.slice(0, -2)).toEqual(streamPrompts[0]!.content.slice(0, -2));
    expect(JSON.stringify(streamPrompts[2]!.content.at(-2))).toContain("; edited:");
    expect(stored.map((message) => message.content)).toEqual([
      "hi",
      "first answer",
      "What time is it?",
      "alpha beta gamma delta epsilon",
    ]);
  }, 60_000);

  it("regenerates the answer with the model the retry picked", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* seedAnswered(textModelId);

        yield* chat.retryMessage({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: visionModelId,
        });
        // Runs until the restarted generation reports done.
        yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);

        return {
          message: yield* repo.getMessage(assistant.id),
          conversation: yield* repo.getConversation(userId, conversation.id),
        };
      }),
    );

    expect(result.message).toMatchObject({
      status: "complete",
      modelId: visionModelId,
      content: "alpha beta gamma delta epsilon",
    });
    // The switch is for this attempt only — the composer's default is untouched.
    expect(result.conversation.modelId).toBe(textModelId);
  }, 60_000);

  it("reuses the model that answered before when none is picked", async () => {
    const message = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* seedAnswered(textModelId);

        yield* chat.retryMessage({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
        });
        yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);
        return yield* repo.getMessage(assistant.id);
      }),
    );

    expect(message).toMatchObject({ status: "complete", modelId: textModelId });
  }, 60_000);

  it("refuses a model that cannot read a file already in the conversation", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const { userId, conversation, userMessage, assistant } = yield* seedAnswered(visionModelId);
        yield* attachImage(userId, userMessage.id);

        const failure = yield* chat
          .retryMessage({
            userId,
            conversationId: conversation.id,
            messageId: assistant.id,
            modelId: textModelId,
          })
          .pipe(Effect.catch((error) => Effect.succeed(error)));

        return { failure, message: yield* repo.getMessage(assistant.id) };
      }),
    );

    expect(result.failure).toMatchObject({ _tag: "AttachmentUnsupported", fileName: "shot.png" });
    // Rejected before anything was wiped: the previous answer is still there.
    expect(result.message).toMatchObject({ status: "complete", content: "first answer" });
  }, 60_000);
});

describe("generated image streaming", () => {
  it("keeps distinct initial and edited image bytes, history, public refs and authenticated reads", async () => {
    const promptStart = streamPrompts.length;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const engine = yield* StreamEngine;
          const files = yield* AttachmentService;
          const db = yield* Db;
          const { userId, conversation, assistant } = yield* setupConversation;
          const run = (message: typeof assistant) =>
            engine
              .startGeneration({
                userId,
                conversationId: conversation.id,
                messageId: message.id,
                generationId: message.generationId ?? undefined,
                modelId: imageModelId,
                searchEnabled: false,
              })
              .pipe(
                Effect.andThen(
                  engine
                    .subscribe(message.id, 0, message.generationId ?? undefined)
                    .pipe(Stream.runCollect),
                ),
              );
          yield* run(assistant);
          const initial = yield* repo.getMessage(assistant.id);
          const initialId = initial!.assistantOutput!.images[0]!.attachment.id;

          const edit = yield* repo.createTurn({
            userId,
            conversationId: conversation.id,
            modelId: imageModelId,
            content: "Replace the original image with a blue image",
            attachmentIds: [],
          });
          nextGeneratedImage = editedPng;
          const editedEvents = yield* run(edit.assistant);
          const edited = yield* repo.getMessage(edit.assistant.id);
          expect(edited!.status).toBe("complete");
          const editedId = edited!.assistantOutput!.images[0]!.attachment.id;
          expect(editedId).not.toBe(initialId);
          const event = editedEvents.find(
            (event) => event.kind === "chunk" && event.chunkKind === "image",
          );
          expect(event && event.kind === "chunk" ? JSON.parse(event.delta) : null).toMatchObject({
            attachment: { id: editedId },
          });

          for (const [id, bytes] of [
            [initialId, generatedPng],
            [editedId, editedPng],
          ] as const) {
            const file = yield* files.read({ userId, attachmentId: id });
            expect(Buffer.from(file.bytes).equals(bytes)).toBe(true);
            const [stored] = yield* db
              .select()
              .from(attachments)
              .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
              .where(eq(attachments.id, id));
            const sha = createHash("sha256").update(bytes).digest("hex");
            expect(stored!.attachment_blobs.sha256).toBe(sha);
            expect(stored!.attachment_blobs.storageKey).toContain(sha);
          }
          const detail = yield* loadConversationDetail(userId, conversation.id);
          expect(
            detail.messages.find((message) => message.id === assistant.id)!.assistantOutput!
              .images[0]!.attachment.id,
          ).toBe(initialId);
          expect(
            detail.messages.find((message) => message.id === edit.assistant.id)!.assistantOutput!
              .images[0]!.attachment.id,
          ).toBe(editedId);

          const followup = yield* repo.createTurn({
            userId,
            conversationId: conversation.id,
            modelId: imageModelId,
            content: "Make the latest blue image larger",
            attachmentIds: [],
          });
          yield* run(followup.assistant);
          const prompts = streamPrompts.slice(promptStart);
          expect(prompts).toHaveLength(3);
          const replayImages = (prompt: Prompt.Prompt) =>
            prompt.content.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) =>
                    part.type === "file" && part.data instanceof Uint8Array
                      ? [Buffer.from(part.data).toString("base64")]
                      : [],
                  )
                : [],
            );
          expect(replayImages(prompts[0]!)).toEqual([]);
          expect(replayImages(prompts[1]!)).toEqual([generatedPng.toString("base64")]);
          expect(replayImages(prompts[2]!)).toEqual([
            generatedPng.toString("base64"),
            editedPng.toString("base64"),
          ]);
          expect(JSON.stringify(prompts[1])).toContain(
            "Replace the original image with a blue image",
          );
          expect(JSON.stringify(prompts[2])).toContain("Make the latest blue image larger");
        }),
      );
    } finally {
      nextGeneratedImage = undefined;
    }
  });
  it("publishes ordered ref-only image chunks and replays the same durable output", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const { userId, conversation, assistant } = yield* setupConversation;
        yield* engine.startGeneration({
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          generationId: assistant.generationId ?? undefined,
          modelId: imageModelId,
          searchEnabled: false,
        });
        const live = Array.from(
          yield* engine
            .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
            .pipe(Stream.runCollect),
        );
        const replay = Array.from(
          yield* engine
            .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
            .pipe(Stream.runCollect),
        );
        expect(live).toEqual(replay);
        expect(
          live.filter((event) => event.kind === "chunk").map((event) => event.chunkKind),
        ).toEqual(["text", "image", "text"]);
        expect(live.at(-1)).toMatchObject({
          kind: "done",
          status: "complete",
          runId: assistant.generationId,
        });
        expect(JSON.stringify(live)).not.toContain(generatedPng.toString("base64"));
        expect(JSON.stringify(live)).not.toContain("private-replay");
        const publicDetail = yield* loadConversationDetail(userId, conversation.id);
        expect(JSON.stringify(publicDetail)).not.toContain("private-replay");
        expect(JSON.stringify(publicDetail)).not.toContain("providerReplay");
        expect(JSON.stringify(publicDetail)).not.toContain(generatedPng.toString("base64"));
        const final = yield* repo.getMessage(assistant.id);
        expect(final).toMatchObject({
          content: "BeforeAfter",
          status: "complete",
          assistantOutput: { images: [{ textOffset: 6, turnIndex: 0 }] },
          providerReplay: { turns: [{ reasoningDetails: [{ data: "private-replay" }] }] },
        });
      }),
    );
  });
});

describe("terminal response validation", () => {
  for (const reason of ["unknown", "other"] as const) {
    it(`rejects ${reason} after Hermes parsing without a continuation and retains usage`, async () => {
      const parts = await Effect.runPromise(
        Stream.runCollect(
          hermesToolCalls(
            Stream.fromIterable([
              AiResponse.makePart("text-delta", {
                id: "t",
                delta: `Checking. <tool_call>${JSON.stringify({ name: "ask_user", arguments: questionParams })}</tool_call>`,
              }),
              AiResponse.makePart("finish", {
                reason,
                usage: new AiResponse.Usage({
                  inputTokens: { total: 12 },
                  outputTokens: { total: 4 },
                }),
                metadata: {
                  openrouter: {
                    usage: {
                      prompt_tokens: 12,
                      completion_tokens: 4,
                      total_tokens: 16,
                      cost: 0.04,
                    },
                  },
                },
              }),
            ]),
            { tools: [askUserTool], nextId: Effect.succeed("hermes-question") },
          ),
        ),
      );
      // If the wrapper masks the finish, the ordinary loop takes this extra
      // round and completes, rather than rejecting the incomplete first turn.
      terminalFixtures = [
        Array.from(parts),
        [
          AiResponse.makePart("text-delta", { id: "t2", delta: "A later answer." }),
          AiResponse.makePart("finish", {
            reason: "stop",
            usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
          }),
        ],
      ];
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* ChatRepo;
            const engine = yield* StreamEngine;
            const db = yield* Db;
            const { userId, conversation, assistant } = yield* setupConversation;
            yield* engine.startGeneration({
              userId,
              conversationId: conversation.id,
              messageId: assistant.id,
              generationId: assistant.generationId ?? undefined,
              modelId: textModelId,
              searchEnabled: false,
            });
            const events = yield* engine
              .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
              .pipe(Stream.runCollect);
            expect(events.at(-1)).toMatchObject({ kind: "done", status: "error" });
            expect(yield* repo.getMessage(assistant.id)).toMatchObject({
              status: "error",
              content: "Checking. ",
              error: { message: expect.stringContaining("[ResponseIncomplete]") },
            });
            const ledger = yield* db
              .select()
              .from(usageEvents)
              .where(eq(usageEvents.messageId, assistant.id));
            expect(ledger).toHaveLength(1);
            expect(ledger[0]).toMatchObject({
              status: "error",
              inputTokens: 12,
              outputTokens: 4,
              cost: 0.04,
            });
            expect(terminalFixtures).toHaveLength(1);
          }),
        );
      } finally {
        terminalFixtures = undefined;
      }
    });
  }
  for (const [reason, text, image, code] of [
    ["stop", "", false, "ResponseEmpty"],
    ["stop", " \n", false, "ResponseEmpty"],
    ["content-filter", "", false, "ResponseFiltered"],
    ["error", "", false, "ResponseError"],
    [undefined, "", false, "ResponseIncomplete"],
    ["other", "", false, "ResponseIncomplete"],
    ["unknown", "Partial explanation", false, "ResponseIncomplete"],
    ["content-filter", "Partial explanation", true, "ResponseFiltered"],
    ["error", "Partial explanation", true, "ResponseError"],
    [undefined, "Partial explanation", true, "ResponseIncomplete"],
    ["stop", "A text-only explanation", false, undefined],
    ["stop", "", true, undefined],
  ] as const) {
    it(`handles ${reason} text=${JSON.stringify(text)} image=${image}`, async () => {
      const parts: ChatStreamPart[] = [];
      if (text) parts.push(AiResponse.makePart("text-delta", { id: "t", delta: text }));
      if (image)
        parts.push(AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }));
      if (reason)
        parts.push(
          AiResponse.makePart("finish", {
            reason,
            usage: new AiResponse.Usage({ inputTokens: { total: 12 }, outputTokens: { total: 4 } }),
            metadata: {
              openrouter: {
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.04 },
              },
            },
          }),
        );
      terminalFixtures = [parts];
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* ChatRepo;
            const engine = yield* StreamEngine;
            const db = yield* Db;
            const { userId, conversation, assistant } = yield* setupConversation;
            yield* engine.startGeneration({
              userId,
              conversationId: conversation.id,
              messageId: assistant.id,
              generationId: assistant.generationId ?? undefined,
              modelId: imageModelId,
              searchEnabled: false,
            });
            const events = yield* engine
              .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
              .pipe(Stream.runCollect);
            const status = code ? "error" : "complete";
            expect(events.at(-1)).toMatchObject({ kind: "done", status });
            const message = yield* repo.getMessage(assistant.id);
            expect(message).toMatchObject({ content: text, status });
            expect(message?.assistantOutput?.images.length ?? 0).toBe(image ? 1 : 0);
            if (code) expect(message?.error?.message).toContain(`[${code}]`);
            else expect(message?.error).toBeNull();
            const ledger = yield* db
              .select()
              .from(usageEvents)
              .where(eq(usageEvents.messageId, assistant.id));
            expect(ledger).toHaveLength(1);
            expect(ledger[0]).toMatchObject({
              status,
              inputTokens: reason ? 12 : 0,
              outputTokens: reason ? 4 : 0,
              cost: reason ? 0.04 : null,
            });
            expect(JSON.stringify(events)).not.toContain(generatedPng.toString("base64"));
            expect(terminalFixtures).toHaveLength(0);
          }),
        );
      } finally {
        terminalFixtures = undefined;
      }
    });
  }
});

for (const presented of [true, false]) {
  it(`permits ${presented ? "a question-only answer" : "a tool-only continuation before the answer"}`, async () => {
    const result = presented
      ? { v: 1, outcome: "presented", ...questionParams }
      : { v: 1, outcome: "rejected", message: "Please use a sensible default." };
    const finish = (reason: AiResponse.FinishReason) =>
      AiResponse.makePart("finish", {
        reason,
        usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
      });
    terminalFixtures = [
      [
        AiResponse.makePart("tool-call", {
          id: "ask-terminal",
          providerExecuted: false,
          name: "ask_user",
          params: questionParams,
        }),
        AiResponse.makePart("tool-result", {
          id: "ask-terminal",
          providerExecuted: false,
          name: "ask_user",
          result,
          encodedResult: result,
          isFailure: false,
          preliminary: false,
        }),
        finish("tool-calls"),
      ],
      ...(presented
        ? []
        : [
            [
              AiResponse.makePart("text-delta", { id: "answer", delta: "A sensible answer." }),
              finish("stop"),
            ],
          ]),
    ];
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const engine = yield* StreamEngine;
          const { userId, conversation, assistant } = yield* setupConversation;
          yield* engine.startGeneration({
            userId,
            conversationId: conversation.id,
            messageId: assistant.id,
            generationId: assistant.generationId ?? undefined,
            modelId: imageModelId,
            searchEnabled: false,
          });
          const events = yield* engine
            .subscribe(assistant.id, 0, assistant.generationId ?? undefined)
            .pipe(Stream.runCollect);
          expect(events.at(-1)).toMatchObject({ kind: "done", status: "complete" });
          expect(yield* repo.getMessage(assistant.id)).toMatchObject({
            status: "complete",
            content: presented ? "" : "A sensible answer.",
            error: null,
          });
          expect(terminalFixtures).toHaveLength(0);
        }),
      );
    } finally {
      terminalFixtures = undefined;
    }
  });
}

describe("local tools on the user's machine", () => {
  const folder = "acme-site";
  const desktopChat = Effect.gen(function* () {
    const seed = yield* setupConversation;
    const conversation = yield* (yield* ChatRepo).createConversation({
      userId: seed.userId,
      modelId: textModelId,
    });
    return { ...seed, conversation };
  });

  const send = (seed: Effect.Success<typeof desktopChat>, desktopCommands = false) =>
    Effect.flatMap(ChatService, (service) =>
      service.sendMessage({
        userId: seed.userId,
        conversationId: seed.conversation.id,
        modelId: textModelId,
        content: "What is in the readme?",
        searchEnabled: false,
        attachmentIds: [],
        desktopFolder: folder,
        desktopCommands,
      }),
    );

  /**
   * Stands in for the page: subscribes to the same stream the browser does,
   * and answers each call it is told about. Deliberately learns about calls the
   * way the real client does rather than by reading the database, because the
   * start envelope carrying the arguments is the seam most likely to rot.
   */
  interface DesktopCall {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }
  const fakeBridge = (messageId: string, answer: (call: DesktopCall) => unknown) =>
    Effect.gen(function* () {
      const external = yield* ExternalCompletion;
      const engine = yield* StreamEngine;
      const seen: Array<DesktopCall> = [];
      // Lets a test act at the moment the page would, without polling for it.
      const first = yield* Deferred.make<DesktopCall>();
      const fiber = yield* Effect.forkChild(
        engine.subscribe(messageId, 0).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.kind !== "chunk" || event.chunkKind !== "tool") return;
              const envelope = Option.getOrNull(
                Schema.decodeUnknownOption(ToolChunkEnvelope)(JSON.parse(event.delta)),
              );
              if (!envelope || envelope.family !== "desktop" || envelope.phase !== "start") return;
              const call = { name: envelope.name, args: { ...envelope.args } };
              seen.push(call);
              yield* Deferred.succeed(first, call);
              const reply = answer(call);
              if (reply !== null) yield* external.complete(envelope.callId, reply);
            }),
          ),
        ),
        { startImmediately: true },
      );
      return { fiber, seen, first };
    });

  // Longer than the excerpt the transcript keeps, so what is kept and what is
  // dropped are both observable. The tail is only ever in the prompt.
  const fileBody = `${"MACHINE_FILE_BODY ".repeat(200)}FILE_TAIL_MARKER`;

  it("folds a machine's answer into the next turn and keeps the body off the row", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "read_local_file", { path: "README.md" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "It describes the site." }),
        authoringFinish(),
      );
    };
    try {
      const sent = await runtime.runPromise(send(seed));
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(sent.assistantMessageId, (call) => ({
            v: 1,
            ok: true,
            summary: `Read ${call.args.path}`,
            detail: fileBody,
            truncated: false,
          }));
          yield* Fiber.join(bridge.fiber);
          return {
            seen: bridge.seen,
            detail: yield* loadConversationDetail(seed.userId, seed.conversation.id),
            chunks: yield* ChatRepo.use((repo) => repo.chunksAfter(sent.assistantMessageId, 0)),
          };
        }),
      );

      // The page was told the tool name and its arguments, which is all it
      // needs to act; nothing else reaches it before the call is answered.
      expect(result.seen).toEqual([{ name: "read_local_file", args: { path: "README.md" } }]);
      // The answer came back through the handler and into the second turn, so
      // the model read the file without the server ever touching it.
      expect(prompts).toHaveLength(2);
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("FILE_TAIL_MARKER");
      // The folder's name reaches the prompt; its path never existed here.
      expect(JSON.stringify(prompts[0]!.prompt)).toContain(folder);

      const call = result.detail.toolCalls.at(-1)!;
      expect(call.toolName).toBe("read_local_file");
      expect(call.status).toBe("complete");
      expect(call.result).toMatchObject({ summary: "Read README.md", ok: true, truncated: true });
      const last = result.detail.messages.at(-1)!;
      expect(last.status).toBe("complete");
      expect(last.content).toContain("It describes the site.");
      // Same rule web tools follow: the whole body reaches the model through
      // the prompt, and only an excerpt of it outlives the generation.
      expect(JSON.stringify(call.result)).not.toContain("FILE_TAIL_MARKER");
      expect(JSON.stringify(result.chunks)).not.toContain("FILE_TAIL_MARKER");
      expect(result.chunks.some((chunk) => chunk.delta.includes('"family":"desktop"'))).toBe(true);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("leaves the row terminal when the generation is stopped mid-wait, and drops a late answer", async () => {
    const seed = await runtime.runPromise(desktopChat);
    authoringScript = (input) => authoringTool(input, "run_command", { command: "pnpm test" });
    try {
      const sent = await runtime.runPromise(send(seed, true));
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const external = yield* ExternalCompletion;
          const engine = yield* StreamEngine;
          // Answering is what the bridge does not do here: null leaves the
          // handler parked exactly as a closed desktop app would.
          const bridge = yield* fakeBridge(sent.assistantMessageId, () => null);
          const waited = yield* Deferred.await(bridge.first);
          const running = yield* ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId));
          const stopped = yield* engine.stopGeneration(
            sent.assistantMessageId,
            running?.generationId ?? undefined,
          );
          yield* Fiber.join(bridge.fiber);
          const detail = yield* loadConversationDetail(seed.userId, seed.conversation.id);
          const callId = detail.toolCalls.at(-1)!.id;
          return {
            waited,
            stopped,
            detail,
            // Nobody is parked on it any more, so an answer from a page that
            // did not notice the stop has nowhere to be written.
            late: yield* external.complete(callId, {
              v: 1,
              ok: true,
              summary: "Ran pnpm test",
              detail: "LATE_ANSWER",
              truncated: false,
            }),
          };
        }),
      );

      expect(result.waited).toEqual({ name: "run_command", args: { command: "pnpm test" } });
      expect(result.stopped).toBe(true);
      expect(result.late).toBe(false);
      const call = result.detail.toolCalls.at(-1)!;
      expect(call.toolName).toBe("run_command");
      expect(call.status).toBe("error");
      expect(result.detail.messages.at(-1)?.status).toBe("aborted");
      expect(JSON.stringify(result.detail)).not.toContain("LATE_ANSWER");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("withholds only the command tool when the machine cannot sandbox", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "I will read it instead." }),
        authoringFinish(),
      );
    };
    try {
      const sent = await runtime.runPromise(send(seed));
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(sent.assistantMessageId, 0)),
        ),
      );
      // A missing shell prerequisite costs the command tool, never the folder.
      const offered = Object.keys(prompts[0]!.toolkit?.tools ?? {});
      expect(offered).toContain("read_local_file");
      expect(offered).toContain("write_local_file");
      expect(offered).not.toContain("run_command");
      // And the model is told, rather than left to discover it by trying.
      expect(JSON.stringify(prompts[0]!.prompt)).toContain("Running commands is unavailable");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("refuses to continue a work chat without a folder, and stays a work chat", async () => {
    const seed = await runtime.runPromise(desktopChat);
    authoringScript = () =>
      Stream.make(AiResponse.makePart("text-delta", { id: "t", delta: "Hi." }), authoringFinish());
    try {
      // The first send creates the conversation and fixes its mode.
      const created = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: null,
            modelId: textModelId,
            content: "Start work.",
            searchEnabled: false,
            attachmentIds: [],
            mode: "work",
            desktopFolder: folder,
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(created.assistantMessageId, 0)),
        ),
      );
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, created.conversationId),
      );
      expect(detail.conversation.mode).toBe("work");

      // A browser tab, or the desktop app before a folder is chosen, sends
      // nothing about a folder. That is refused rather than run as plain chat.
      const refused = await runtime.runPromise(
        Effect.result(
          Effect.flatMap(ChatService, (service) =>
            service.sendMessage({
              userId: seed.userId,
              conversationId: created.conversationId,
              modelId: textModelId,
              content: "Keep going.",
              searchEnabled: false,
              attachmentIds: [],
            }),
          ),
        ),
      );
      expect(refused._tag === "Failure" && refused.failure._tag).toBe("WorkFolderRequired");
      // Nothing was written: the refusal happened inside the turn, before rows.
      const after = await runtime.runPromise(
        loadConversationDetail(seed.userId, created.conversationId),
      );
      expect(after.messages).toHaveLength(detail.messages.length);

      // A later send cannot change the mode; a plain chat stays plain.
      const plain = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Hello.",
            searchEnabled: false,
            attachmentIds: [],
            mode: "work",
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(plain.assistantMessageId, 0)),
        ),
      );
      expect(
        (await runtime.runPromise(loadConversationDetail(seed.userId, seed.conversation.id)))
          .conversation.mode,
      ).toBe("chat");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("withholds the tools when no folder is attached", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "I cannot reach your files." }),
        authoringFinish(),
      );
    };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            modelId: textModelId,
            content: "Read my readme.",
            searchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(sent.assistantMessageId, 0)),
        ),
      );
      // A browser tab never sees these names, which is what keeps the model
      // from proposing work it has no way to do.
      expect(Object.keys(prompts[0]!.toolkit?.tools ?? {})).not.toContain("read_local_file");
    } finally {
      authoringScript = null;
    }
  }, 60_000);
});
