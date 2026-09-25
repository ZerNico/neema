import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { uuidv7 } from "uuidv7";
import { fromBase64, toBase64 } from "lib0/buffer";
import * as Y from "yjs";
import { LanguageModel, Response as AiResponse, type Prompt } from "effect/unstable/ai";
import { eq, sql } from "drizzle-orm";
import {
  conversationDrafts,
  conversations,
  schedules,
  groups,
  groupMembers,
  attachmentBlobs,
  attachments,
  messageAttachments,
  messageChunks,
  messageGenerationConfig,
  messages,
  models,
  skills,
  skillRevisions,
  usageEvents,
  workTurnReservations,
} from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { EMPTY_AGENT_DRAFT } from "~/modules/agents/draft-schema.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import {
  CustomToolRuntime,
  type CustomToolRunResult,
} from "~/modules/custom-tools/server/runtime.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { readMarkdown, writeMarkdown } from "~/modules/documents/editor/markdown.ts";
import type { DocumentFrame } from "~/modules/documents/schema.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { loadConversationDetail } from "~/modules/chat/server/conversation-detail.ts";
import { ChatRepo, PLAIN_GENERATION } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { EditNotAllowed } from "~/modules/chat/errors.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { GenerationFence, QueueSweepInterval } from "~/modules/chat/server/generation-fence.ts";
import { estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { ScheduleDraftService } from "~/modules/schedules/server/draft-service.ts";
import { SCHEDULE_AUTHORING_SKILL } from "~/modules/skills/bundled/index.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { hermesToolCalls } from "~/modules/providers/server/hermes-tools.ts";
import { askUserTool } from "~/modules/tools/server/ask-user.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import {
  FakeDocumentParser,
  FakeWebSearch,
  FakeUrlReader,
  NoIntegrations,
} from "./unused-services.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

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

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  | AgentRepo
  | AgentDraftService
  | CustomToolRepo
  | DocumentService
  | ChatRepo
  | ProviderRepo
  | ChatService
  | StreamEngine
  | SyncBus
  | Db
  | AttachmentRepo
  | AttachmentService
  | ExternalCompletion
  | ScheduleRepo,
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
/** Set by a test that pins a custom tool; the runtime is otherwise never called. */
let customToolRun: ((input: { functionKey: string }) => Effect.Effect<CustomToolRunResult>) | null =
  null;
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
/** A native call whose arguments stream in pieces first, the way providers send them. */
const streamedTool = (input: GatewayInput, name: string, params: unknown, pieces = 12) => {
  const id = uuidv7();
  const json = JSON.stringify(params);
  const size = Math.ceil(json.length / pieces);
  const deltas = Array.from({ length: pieces }, (_, index) =>
    AiResponse.makePart("tool-params-delta", {
      id,
      delta: json.slice(index * size, (index + 1) * size),
    }),
  );
  const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
  return Stream.unwrap(
    LanguageModel.make({
      generateText: () => Effect.die("only streaming is used here"),
      streamText: () =>
        Stream.make(
          AiResponse.makePart("tool-params-start", { id, name, providerExecuted: false }),
          ...deltas,
          AiResponse.makePart("tool-params-end", { id }),
          AiResponse.makePart("tool-call", { id, name, params, providerExecuted: false }),
          authoringFinish("tool-calls"),
        ).pipe(
          Stream.mapEffect((part) => encodePart(part)),
          Stream.orDie,
        ),
    }).pipe(
      Effect.map((model) => model.streamText({ prompt: input.prompt, toolkit: input.toolkit! })),
    ),
  ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
};
const authoringTool = (input: GatewayInput, name: string, params: unknown, hermes = false) => {
  const id = uuidv7();
  const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
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
  // Use the SDK's concurrent dispatch, not a sequential call-then-handler fake.
  return Stream.unwrap(
    LanguageModel.make({
      generateText: () => Effect.die("only streaming is used here"),
      streamText: () =>
        calls.pipe(
          Stream.mapEffect((part) => encodePart(part)),
          Stream.orDie,
        ),
    }).pipe(
      Effect.map((model) => model.streamText({ prompt: input.prompt, toolkit: input.toolkit! })),
    ),
  ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
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
          } as ChatStreamPart),
        ),
      );
    }),
});

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const PgLive = PgClient.layer({ url: Redacted.make(url), maxConnections: 5 });
  const InfraLayer = Db.layer.pipe(Layer.provideMerge(PgLive));
  // ChatRepo reconciles attachment claims, so AttachmentRepo sits under it.
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
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(InfraLayer),
  );
  const EngineCore = Layer.mergeAll(
    FakeGateway,
    FakeKnowledge,
    FakeWebSearch,
    FakeUrlReader,
    ImageBlobStore,
    FakeDocumentParser,
    Layer.succeed(CustomToolRuntime, {
      inspect: () => Effect.die("no custom tool builds in these tests"),
      run: (input) =>
        customToolRun ? customToolRun(input) : Effect.die("no custom tool calls in these tests"),
    }),
    FakeMemoryService,
    NoIntegrations,
    ExternalCompletion.layer,
    SyncBus.layer,
    Layer.mergeAll(ScheduleDraftService.layer, AgentDraftService.layer).pipe(
      Layer.provideMerge(SyncBus.layer),
    ),
  ).pipe(Layer.provideMerge(ReposLayer));
  const EngineLayer = StreamEngine.layer.pipe(
    Layer.provideMerge(AttachmentService.layer.pipe(Layer.provideMerge(EngineCore))),
  );
  // No background sweep: tests that assert queue state would otherwise race a
  // start nobody asked for. Settled hooks and explicit dispatch still run.
  const AppLayer = ChatService.layer.pipe(
    Layer.provideMerge(EngineLayer),
    Layer.provide(Layer.succeed(QueueSweepInterval, null)),
  );
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
  await database?.drop();
});

const setupConversation = Effect.gen(function* () {
  const repo = yield* ChatRepo;
  const db = yield* Db;
  const userId = uuidv7();
  // repo has no user creation, so insert the auth user row directly
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

/**
 * The same seed as a Work chat, which only a desktop app starts: a finished
 * answer does not start its next queued entry by itself.
 */
const setupWorkConversation = <A extends { conversation: { id: string } }, E, R>(
  setup: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const seed = yield* setup;
    const db = yield* Db;
    yield* db
      .update(conversations)
      .set({ mode: "work" })
      .where(eq(conversations.id, seed.conversation.id));
    return seed;
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
  conversation: { kind: "existing" as const, id: seed.conversation.id },
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
              conversation: { kind: "existing", id: seed.conversation.id },
              modelId: textModelId,
              content: "Help me edit this agent.",
              searchEnabled: false,
              researchEnabled: false,
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
        // Retrying the answer that opened the draft takes the draft with it, like
        // a document: nothing in the transcript would introduce it any more. The
        // agent it already saved is a resource of its own and stays.
        authoringScript = (input) => {
          expect(JSON.stringify(input.prompt)).not.toContain("PRIVATE_LATER_DRAFT");
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
        expect(retried.agentDrafts).toEqual([]);
        expect(
          await runtime.runPromise(AgentRepo.use((repo) => repo.get(seed.userId, targetId))),
        ).toMatchObject({ row: { configRevision: 2 } });
      } finally {
        authoringScript = null;
      }
    },
  );

  it("removes a draft with the answer that opened it when an earlier message is edited", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const conversationId = seed.conversation.id;
    const turn = (content: string) =>
      runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
    const edit = (messageId: string) =>
      runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.editMessage({
            userId: seed.userId,
            conversationId,
            messageId,
            modelId: textModelId,
            content: "Something else.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
    const drafts = () =>
      runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select()
            .from(conversationDrafts)
            .where(eq(conversationDrafts.conversationId, conversationId)),
        ),
      );
    let round = 0;
    authoringScript = (input) =>
      ++round === 1
        ? authoringTool(input, "draft_schedule", { changes: { name: "Morning digest" } })
        : reply();
    try {
      const first = await turn("Draft me a morning digest.");
      await collectDraftTurn(first.assistantMessageId);
      const [draft] = await drafts();
      expect(draft).toMatchObject({
        kind: "schedule",
        settings: { name: "Morning digest" },
        createdByMessageId: first.assistantMessageId,
      });
      const second = await turn("Thanks.");
      await collectDraftTurn(second.assistantMessageId);
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      expect(detail.scheduleDrafts).toEqual([
        { id: draft!.id, name: "Morning digest", messageId: first.assistantMessageId },
      ]);

      // Editing the later message rewinds only past its own answer.
      const later = await edit(detail.messages[2]!.id);
      await collectDraftTurn(later.assistantMessageId);
      expect((await drafts()).map((row) => row.id)).toEqual([draft!.id]);

      // Editing the message that led to the draft rewinds the answer that opened it.
      const earlier = await edit(detail.messages[0]!.id);
      await collectDraftTurn(earlier.assistantMessageId);
      expect(await drafts()).toEqual([]);
    } finally {
      authoringScript = null;
    }
  });

  it("replays a skill where an earlier answer loaded it, identical on every later turn", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const turn = (content: string) =>
      runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
    const root = SCHEDULE_AUTHORING_SKILL.root;
    const occurrences = (input: GatewayInput) =>
      JSON.stringify(input.prompt).split(JSON.stringify(root).slice(1, 80)).length - 1;
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return prompts.length === 1
        ? authoringTool(input, "load_skill", { skillId: SCHEDULE_AUTHORING_SKILL.id })
        : reply();
    };
    try {
      for (const content of ["Set up a morning digest.", "Weekdays only.", "Thanks."]) {
        const sent = await turn(content);
        await collectDraftTurn(sent.assistantMessageId);
      }
      // One load, then two turns that answer straight away.
      expect(prompts).toHaveLength(4);
      const [, loadedNow, later, latest] = prompts;
      // In the loading attempt the text is trailing context, once.
      expect(occurrences(loadedNow!)).toBe(1);
      for (const input of [later!, latest!]) {
        expect(occurrences(input)).toBe(1);
        expect(JSON.stringify(input.prompt)).toContain(
          "Already loaded earlier in this conversation",
        );
      }
      // The replay sits in history, before the answer that loaded it, and
      // everything up to that answer is byte-identical from turn to turn: the
      // prefix a provider cache can reuse.
      const content = (input: GatewayInput) => input.prompt.content;
      const replayAt = content(later!).findIndex((message) =>
        JSON.stringify(message).includes("Skill instructions loaded with load_skill"),
      );
      expect(replayAt).toBeGreaterThan(0);
      const answerAt = content(later!).findIndex(
        (message, index) => index > replayAt && message.role === "assistant",
      );
      expect(answerAt).toBeGreaterThan(replayAt);
      expect(JSON.stringify(content(latest!).slice(0, answerAt + 1))).toBe(
        JSON.stringify(content(later!).slice(0, answerAt + 1)),
      );
    } finally {
      authoringScript = null;
    }
  });

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
              conversation: { kind: "existing", id: seed.conversation.id },
              modelId: textModelId,
              content: "Prepare an agent.",
              searchEnabled: false,
              researchEnabled: false,
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
            createdByMessageId: seed.assistant.id,
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
          service.sendMessage({
            ...answerInput(seed),
            searchEnabled: false,
            researchEnabled: false,
          }),
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Use Claude as the preferred model.",
            searchEnabled: false,
            researchEnabled: false,
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Find a skill for a future agent.",
            searchEnabled: false,
            researchEnabled: false,
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Make a Jira agent.",
            searchEnabled: false,
            researchEnabled: false,
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Make a ticket agent.",
            searchEnabled: false,
            researchEnabled: false,
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Now make a release notes agent.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(second.assistantMessageId);
      const both = await runtime.runPromise(drafts);
      expect(both).toHaveLength(2);
      // The saved agent keeps the first draft's settings; the second is separate.
      expect(both.find((draft) => draft.targetId === saved.agentId)).toMatchObject({
        settings: { name: "Tickets", instructions: "PRIVATE_FIRST" },
      });
      expect(both.find((draft) => draft.targetId === null)).toMatchObject({
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Make two agents.",
            searchEnabled: false,
            researchEnabled: false,
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Edit this unavailable agent.",
            searchEnabled: false,
            researchEnabled: false,
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

describe("conversation documents", () => {
  const CHECKLIST = "# Release\n\n- [ ] write notes\n- [ ] tag build\n- [ ] ship";
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
      AiResponse.makePart("text-delta", { id: "t", delta: "The checklist is ready." }),
      authoringFinish(),
    );
  const settle = (id: string) =>
    runtime.runPromise(
      Effect.flatMap(StreamEngine, (engine) => Stream.runCollect(engine.subscribe(id, 0))),
    );
  const send = (seed: Effect.Success<typeof ordinaryChat>, openDocumentId?: string) =>
    runtime.runPromise(
      Effect.flatMap(ChatService, (service) =>
        service.sendMessage({
          userId: seed.userId,
          conversation: { kind: "existing", id: seed.conversation.id },
          modelId: textModelId,
          content: "Make me a release checklist.",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
          openDocumentId,
        }),
      ),
    );
  const documentsOf = (seed: Effect.Success<typeof ordinaryChat>) =>
    runtime.runPromise(
      Effect.flatMap(DocumentService, (service) =>
        service.list(seed.userId, { conversationId: seed.conversation.id }),
      ),
    );
  // The tool-role messages of a prompt: what the continuation transcript feeds
  // back, as opposed to the trailing data, which carries the document on purpose.
  const toolMessages = (input: GatewayInput) =>
    JSON.stringify(input.prompt.content.filter((message) => message.role === "tool"));
  const trailing = (input: GatewayInput) => {
    const message = [...input.prompt.content]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === "assistant" &&
          JSON.stringify(candidate.content).includes("Application-provided documents"),
      );
    if (!message) return null;
    const text = (message.content as ReadonlyArray<{ text?: string }>)
      .map((part) => part.text ?? "")
      .join("");
    return JSON.parse(text.split("\n").slice(1).join("\n")) as {
      focused: {
        id: string;
        title: string;
        revision: number;
        lastEditedBy: string;
        editedSinceYourLastWrite: boolean;
        content: string;
      } | null;
      others: ReadonlyArray<{ id: string; title: string; chars: number }>;
    };
  };

  it.each([false, true])(
    "creates and patches a document without content in the transcript (Hermes: %s)",
    async (hermes) => {
      const seed = await runtime.runPromise(ordinaryChat);
      const prompts: GatewayInput[] = [];
      authoringScript = (input) => {
        prompts.push(input);
        if (prompts.length === 1)
          return authoringTool(
            input,
            "create_document",
            { title: "Release checklist", content: CHECKLIST },
            hermes,
          );
        if (prompts.length === 2)
          return authoringTool(
            input,
            "edit_document",
            { old: "- [ ] ship", new: "- [ ] ship\n- [ ] announce", expectedRevision: 1 },
            hermes,
          );
        return reply();
      };
      try {
        const sent = await send(seed);
        await settle(sent.assistantMessageId);
        expect(prompts).toHaveLength(3);
        // Before any document exists the long policy stays out of the prompt.
        expect(JSON.stringify(prompts[0]!.prompt)).not.toContain("DATA TO EDIT");
        expect(trailing(prompts[0]!)).toBeNull();
        expect(trailing(prompts[1]!)).toMatchObject({
          focused: { title: "Release checklist", revision: 1, content: CHECKLIST },
          others: [],
        });
        expect(trailing(prompts[2]!)!.focused).toMatchObject({
          revision: 2,
          lastEditedBy: "model",
          editedSinceYourLastWrite: false,
          content: `${CHECKLIST}\n- [ ] announce`,
        });
        // The continuation carries pointers, never the document.
        expect(toolMessages(prompts[2]!)).toContain("trailing application data");
        expect(toolMessages(prompts[2]!)).not.toContain("write notes");
        expect(toolMessages(prompts[2]!)).not.toContain("announce");
        const [document] = await documentsOf(seed);
        expect(document).toMatchObject({
          title: "Release checklist",
          revision: 2,
          lastEditedBy: "model",
          content: `${CHECKLIST}\n- [ ] announce`,
        });
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, seed.conversation.id),
        );
        expect(document!.createdByMessageId).toBe(detail.messages.at(-1)?.id);
        expect(detail.messages.at(-1)?.status).toBe("complete");
        expect(detail.toolCalls.map((call) => call.arguments)).toEqual([{}, {}]);
        expect(detail.toolCalls.map((call) => call.result)).toEqual([
          {
            outcome: "created",
            documentId: document!.id,
            documentConversationId: seed.conversation.id,
            title: "Release checklist",
            revision: 1,
          },
          {
            outcome: "updated",
            documentId: document!.id,
            documentConversationId: seed.conversation.id,
            title: "Release checklist",
            revision: 2,
          },
        ]);
        expect(detail.toolCalls.every((call) => call.status === "complete")).toBe(true);
        expect(JSON.stringify(detail)).not.toContain("write notes");
        const chunks = await runtime.runPromise(
          ChatRepo.use((repo) => repo.chunksAfter(sent.assistantMessageId, 0)),
        );
        expect(JSON.stringify(chunks)).not.toContain("write notes");
        const envelopes = chunks
          .filter((chunk) => chunk.kind === "tool")
          .map((chunk) => JSON.parse(chunk.delta) as { family: string; phase: string });
        expect(envelopes.map((envelope) => `${envelope.family}:${envelope.phase}`)).toEqual([
          "document:start",
          "document:result",
          "document:start",
          "document:result",
        ]);
        expect(envelopes.every((envelope) => Schema.is(ToolChunkEnvelope)(envelope))).toBe(true);
      } finally {
        authoringScript = null;
      }
    },
  );

  it("writes an edit into the open document while its arguments stream, then settles it once", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const frames: DocumentFrame[] = [];
    let watcher: Fiber.Fiber<void> | null = null;
    // Someone has the document open before the edit starts.
    const watch = Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* DocumentService;
          const [document] = yield* service.list(seed.userId, {
            conversationId: seed.conversation.id,
          });
          const feed = yield* service.subscribe(seed.userId, document!.id, {
            stateVector: null,
            clientId: 7,
          });
          watcher = Effect.runFork(
            Stream.runForEach(feed!, (frame) => Effect.sync(() => frames.push(frame))),
          );
        }),
      ),
    );
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Release checklist",
          content: CHECKLIST,
        });
      if (prompts.length === 2)
        return Stream.fromEffectDrain(watch).pipe(
          Stream.concat(
            streamedTool(input, "edit_document", {
              old: "- [ ] tag build",
              new: "- [ ] tag the build and publish the release notes for everyone",
            }),
          ),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toBe(
        CHECKLIST.replace(
          "- [ ] tag build",
          "- [ ] tag the build and publish the release notes for everyone",
        ),
      );
      // Written while streaming, then settled: more than the one write a plain edit makes.
      const updates = frames.filter((frame) => frame.type === "update");
      expect(updates.length).toBeGreaterThanOrEqual(2);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "created",
        "updated",
      ]);
    } finally {
      authoringScript = null;
      if (watcher) await Effect.runPromise(Fiber.interrupt(watcher));
    }
  });

  it("puts the text back when a streamed edit's decoded call is refused", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Release checklist",
          content: CHECKLIST,
        });
      if (prompts.length === 2)
        // A revision that is not a number: the preview streams, the call is refused.
        return streamedTool(input, "edit_document", {
          old: "- [ ] tag build",
          new: "- [ ] tag a completely different build instead",
          expectedRevision: "soon",
        });
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toBe(CHECKLIST);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect((detail.toolCalls[1]!.result as { outcome: string }).outcome).toBe("invalid");
    } finally {
      authoringScript = null;
    }
  });

  it("shows a person's edit between rounds and returns a preview when the anchor is gone", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    // Resolved when it runs: the document only exists once round one has landed.
    const personTicks = Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* DocumentService;
          const [document] = yield* service.list(seed.userId, {
            conversationId: seed.conversation.id,
          });
          // The panel's tick: one marker character in a synced Y.Doc, pushed as a batch.
          const doc = new Y.Doc();
          const feed = yield* service.subscribe(seed.userId, document!.id, {
            stateVector: null,
            clientId: doc.clientID,
          });
          const frame = Option.getOrThrow(yield* Stream.runHead(feed!));
          if (frame.type !== "sync") throw new Error("expected sync");
          Y.applyUpdate(doc, fromBase64(frame.update));
          const updates: Uint8Array[] = [];
          doc.on("update", (update: Uint8Array) => updates.push(update));
          // Ticks the first task, which in the tree is its checked attribute.
          writeMarkdown(doc, readMarkdown(doc).replace("[ ]", "[x]"));
          return yield* service.push(seed.userId, {
            documentId: document!.id,
            clientId: doc.clientID,
            update: toBase64(Y.mergeUpdates(updates)),
          });
        }),
      ),
    );
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Release checklist",
          content: CHECKLIST,
        });
      if (prompts.length === 2)
        return authoringTool(input, "edit_document", {
          old: "- [ ] tag build",
          new: "- [ ] tag build\n- [ ] run tests",
        }).pipe(Stream.concat(Stream.fromEffectDrain(personTicks)));
      if (prompts.length === 3)
        return authoringTool(input, "edit_document", {
          old: "- [ ] write notes",
          new: "- [ ] write release notes",
          expectedRevision: 2,
        });
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      expect(prompts).toHaveLength(4);
      expect(trailing(prompts[2]!)!.focused).toMatchObject({
        revision: 3,
        lastEditedBy: "user",
        editedSinceYourLastWrite: true,
        content: "# Release\n\n- [x] write notes\n- [ ] tag build\n- [ ] run tests\n- [ ] ship",
      });
      // Having seen the current revision through the failed edit, the flag clears.
      expect(trailing(prompts[3]!)!.focused).toMatchObject({
        revision: 3,
        editedSinceYourLastWrite: false,
      });
      const [document] = await documentsOf(seed);
      expect(document).toMatchObject({ revision: 3, lastEditedBy: "user" });
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      const missed = detail.toolCalls[2]!;
      expect(missed.status).toBe("error");
      expect(missed.result).toMatchObject({
        outcome: "no_match",
        documentId: document!.id,
        documentConversationId: seed.conversation.id,
        title: "Release checklist",
        revision: 3,
      });
      expect(Object.keys(missed.result as object).sort()).toEqual([
        "documentConversationId",
        "documentId",
        "message",
        "outcome",
        "revision",
        "title",
      ]);
      expect(missed.error?.code).toBe("DocumentNotUpdated");
      expect(missed.error?.message).toContain("does not occur");
      expect(missed.error?.message).toContain("changed since revision 2");
      // The preview reached the model in the tool result of its own round, and
      // is then dropped from the continuation like the rest of the content.
      expect(JSON.stringify(detail)).not.toContain("[x] write notes");
      expect(toolMessages(prompts[3]!)).not.toContain("[x] write notes");
    } finally {
      authoringScript = null;
    }
  });

  it("interrupts a stale generation's write once a retry has claimed the message", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    const retried = Deferred.makeUnsafe<string>();
    // The first attempt lapses and is retried while its second tool round is
    // still in flight; the edit it then makes must not land.
    const supersede = Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const repo = yield* ChatRepo;
          const assistant = (yield* repo.listMessages(seed.conversation.id)).find(
            (message) => message.role === "assistant",
          )!;
          yield* db
            .update(messages)
            .set({
              generationId: uuidv7(),
              generationLeaseUntil: sql`clock_timestamp() - interval '1 second'`,
            })
            .where(eq(messages.id, assistant.id));
          yield* (yield* StreamEngine).reapOrphans;
          yield* Effect.flatMap(ChatService, (service) =>
            service.retryMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: assistant.id,
            }),
          );
          yield* Deferred.succeed(retried, assistant.id);
        }),
      ),
    );
    authoringScript = (input) => {
      round++;
      if (round === 1)
        return authoringTool(input, "create_document", {
          title: "Release checklist",
          content: CHECKLIST,
        });
      if (round === 2)
        return Stream.fromEffectDrain(supersede).pipe(
          Stream.concat(
            authoringTool(input, "edit_document", { old: "- [ ] ship", new: "- [ ] STALE" }),
          ),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      // Only once the retry has reset the row does a subscription follow the
      // new attempt rather than end on the reaped one.
      const assistantMessageId = await runtime.runPromise(Deferred.await(retried));
      expect(assistantMessageId).toBe(sent.assistantMessageId);
      await settle(assistantMessageId);
      // Retrying the answer discards what that answer created. The stale edit
      // is fenced, and the fresh answer did not create a replacement.
      expect(await documentsOf(seed)).toEqual([]);
      const message = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getMessage(assistantMessageId)),
      );
      expect(message).toMatchObject({ status: "complete", content: "The checklist is ready." });
      expect(round).toBe(3);
    } finally {
      authoringScript = null;
    }
  });

  it("reads the document the person has open first", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const [first, second] = await runtime.runPromise(
      DocumentService.use((service) =>
        Effect.all([
          service.create(seed.userId, {
            conversationId: seed.conversation.id,
            title: "First",
            content: "one",
          }),
          service.create(seed.userId, {
            conversationId: seed.conversation.id,
            title: "Second",
            content: "two",
          }),
        ]),
      ),
    );
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return reply();
    };
    try {
      const sent = await send(seed, first.document.id);
      await settle(sent.assistantMessageId);
      expect(trailing(prompts[0]!)).toMatchObject({
        focused: { id: first.document.id, content: "one" },
        others: [{ id: second.document.id, title: "Second", chars: 3 }],
      });
      expect(JSON.stringify(trailing(prompts[0]!)!.others)).not.toContain("two");
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
            researchEnabled: false,
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
                    conversation: { kind: "existing", id: seed.conversation.id },
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
          conversation: { kind: "existing", id: branch.id },
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
          .sendMessage({
            ...answerInput(seed),
            modelId: uuidv7(),
            searchEnabled: false,
            researchEnabled: false,
          })
          .pipe(Effect.flip);
        const before = yield* repo.listMessages(seed.conversation.id);
        const reply = yield* service.sendMessage({
          ...answerInput(seed),
          modelId: visionModelId,
          searchEnabled: false,
          researchEnabled: false,
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

const plain = () => () => Effect.succeed(PLAIN_GENERATION);
const uploadText = (userId: string, fileName: string, text: string) =>
  Effect.gen(function* () {
    const service = yield* AttachmentService;
    return yield* service.upload({
      userId,
      fileName,
      declaredMediaType: "text/plain",
      bytes: new TextEncoder().encode(text),
    });
  });

const waitForAnswer = (messageId: string) =>
  Effect.gen(function* () {
    const engine = yield* StreamEngine;
    return yield* engine.subscribe(messageId, 0).pipe(Stream.runCollect);
  });

/** A prompt reduced to who spoke and which part of the steered answer it was. */
const promptShape = (prompt: ReadonlyArray<Prompt.MessageEncoded>) =>
  prompt
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "tool"
        ? "tool"
        : `${message.role}:${JSON.stringify(message.content).includes("make it a dog") ? "steer" : JSON.stringify(message.content).includes("Drawing a cat") ? "turn0" : JSON.stringify(message.content).includes("Here is the dog") ? "turn1" : "other"}`,
    );

/** What the queue strip is told about a conversation's queue. */
const queueStateOf = (seed: { userId: string; conversation: { id: string } }) =>
  loadConversationDetail(seed.userId, seed.conversation.id).pipe(
    Effect.map((detail) => detail.queueState),
  );

describe("queued turns", () => {
  const queuedInput = () => ({
    modelId: textModelId,
    searchEnabled: false,
    researchEnabled: false,
  });
  it("promotes exactly the first queued turn, and only the head the caller checked", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const first = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "first",
          attachmentIds: [],
          input: queuedInput(),
        });
        const second = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "second",
          attachmentIds: [],
          input: queuedInput(),
        });
        yield* repo.finalizeMessage({
          messageId: seed.assistant.id,
          status: "complete",
          content: "done",
        });
        // Validated against the wrong head: nothing may start, nothing is consumed.
        const stale = yield* repo.promoteNextQueuedTurn({
          conversationId: seed.conversation.id,
          expectedEntryId: second.id,
          resolve: plain,
        });
        const promoted = yield* repo.promoteNextQueuedTurn({
          conversationId: seed.conversation.id,
          expectedEntryId: first.id,
          resolve: plain,
        });
        return { stale, promoted, queue: yield* repo.listQueue(seed.conversation.id) };
      }),
    );

    expect(result.stale).toEqual({ promoted: false, reason: "changed" });
    expect(result.promoted).toMatchObject({ promoted: true, entry: { content: "first" } });
    expect(result.queue.map((entry) => entry.content)).toEqual(["second"]);
  });

  it("lists only the conversations a dispatch could start", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const queue = (seed: { userId: string; conversation: { id: string } }) =>
          repo.enqueue({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            content: "next",
            attachmentIds: [],
            input: queuedInput(),
          });
        const finished = (seed: { assistant: { id: string } }, status: "complete" | "aborted") =>
          repo.finalizeMessage({ messageId: seed.assistant.id, status, content: "done" });

        const ready = yield* setupConversation;
        yield* finished(ready, "complete");
        yield* queue(ready);

        const asking = yield* setupQuestion;
        yield* queue(asking);

        const failed = yield* setupConversation;
        yield* finished(failed, "complete");
        const failedEntry = yield* queue(failed);
        yield* repo.setQueueEntryError(failedEntry.id, "model gone");

        const stopped = yield* setupConversation;
        yield* finished(stopped, "aborted");
        yield* queue(stopped);

        const work = yield* setupWorkConversation(setupConversation);
        yield* finished(work, "complete");
        yield* queue(work);

        const listed = (mode: "chat" | "work", userId?: string) =>
          repo
            .listQueuedConversations({ limit: 1000, mode, userId })
            .pipe(Effect.map((rows) => new Set(rows.map((row) => row.conversationId))));
        const chat = yield* listed("chat");
        return {
          ready: chat.has(ready.conversation.id),
          asking: chat.has(asking.conversation.id),
          failed: chat.has(failed.conversation.id),
          stopped: chat.has(stopped.conversation.id),
          workInChat: chat.has(work.conversation.id),
          workForItsOwner: (yield* listed("work", work.userId)).has(work.conversation.id),
          workForAnotherUser: (yield* listed("work", ready.userId)).has(work.conversation.id),
        };
      }),
    );

    expect(result).toEqual({
      ready: true,
      asking: false,
      failed: false,
      stopped: false,
      workInChat: false,
      workForItsOwner: true,
      workForAnotherUser: false,
    });
  });

  it("reads past a steer to the question its answer asked", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const seed = yield* setupQuestion;
        // Taken in at a tool boundary, before the answer went on to ask.
        const steerId = uuidv7();
        yield* db.insert(messages).values({
          id: steerId,
          conversationId: seed.conversation.id,
          role: "user",
          status: "complete",
          content: "keep it short",
          steeredIntoMessageId: seed.assistant.id,
          steerTextOffset: 0,
          steerTurnIndex: 0,
        });
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "later",
          attachmentIds: [],
          input: queuedInput(),
        });
        const held = yield* repo.promoteNextQueuedTurn({
          conversationId: seed.conversation.id,
          expectedEntryId: entry.id,
          resolve: plain,
        });
        const edit = yield* chat
          .editMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: steerId,
            content: "rewritten",
            modelId: textModelId,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          })
          .pipe(Effect.flip);
        const reply = yield* repo.createTurn(answerInput(seed));
        return { held, edit, reply: reply.userMessage.questionResponse };
      }),
    );

    // The steer is not the last turn; the answer and its question are.
    expect(result.held).toEqual({ promoted: false, reason: "question" });
    expect(result.edit).toBeInstanceOf(EditNotAllowed);
    expect(result.reply).not.toBeNull();
  });

  it("tells the strip why a queue waits, from the gate promotion reads", async () => {
    const states = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const queue = (seed: { userId: string; conversation: { id: string } }) =>
          repo.enqueue({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            content: "next",
            attachmentIds: [],
            input: queuedInput(),
          });

        const running = yield* setupConversation;
        const empty = yield* queueStateOf(running);
        yield* queue(running);

        const ready = yield* setupConversation;
        yield* repo.finalizeMessage({
          messageId: ready.assistant.id,
          status: "complete",
          content: "ok",
        });
        const failed = yield* setupConversation;
        yield* repo.finalizeMessage({
          messageId: failed.assistant.id,
          status: "complete",
          content: "ok",
        });
        yield* repo.setQueueEntryError((yield* queue(failed)).id, "model gone");
        const stopped = yield* setupConversation;
        yield* repo.finalizeMessage({
          messageId: stopped.assistant.id,
          status: "aborted",
          content: "",
        });
        const asking = yield* setupQuestion;
        yield* queue(ready);
        yield* queue(stopped);
        yield* queue(asking);

        return {
          empty,
          running: yield* queueStateOf(running),
          ready: yield* queueStateOf(ready),
          failed: yield* queueStateOf(failed),
          stopped: yield* queueStateOf(stopped),
          asking: yield* queueStateOf(asking),
        };
      }),
    );

    expect(states).toEqual({
      empty: null,
      running: "running",
      ready: "ready",
      failed: "failed",
      stopped: "stopped",
      asking: "question",
    });
  });

  it("holds queued turns behind an unanswered clarification", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupQuestion;
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "later",
          attachmentIds: [],
          input: queuedInput(),
        });
        return yield* repo.promoteNextQueuedTurn({
          conversationId: seed.conversation.id,
          expectedEntryId: entry.id,
          resolve: plain,
        });
      }),
    );

    expect(result).toEqual({ promoted: false, reason: "question" });
  });

  const firstRound = "Checking the models. ";
  const secondRound = "Here is the ending.";
  /** What the fake model writes in one plain call. */
  const oneRound = "alpha beta gamma delta epsilon";
  /**
   * A finished answer that took a queued message with a file at a tool
   * boundary: the first model call writes a sentence and calls a read-only
   * tool, the steer is claimed once that result is in, and the second call
   * continues the same answer with it.
   */
  const steeredConversation = Effect.gen(function* () {
    const engine = yield* StreamEngine;
    const repo = yield* ChatRepo;
    const seed = yield* setupConversation;
    const file = yield* uploadText(seed.userId, "steer.txt", "Steer file body 42");
    const entry = yield* repo.enqueue({
      userId: seed.userId,
      conversationId: seed.conversation.id,
      content: "use a different ending",
      attachmentIds: [file.id],
      input: queuedInput(),
    });
    yield* repo.steerQueueEntry({
      userId: seed.userId,
      conversationId: seed.conversation.id,
      entryId: entry.id,
      messageId: seed.assistant.id,
      generationId: seed.assistant.generationId!,
    });
    const promptsBefore = streamPrompts.length;
    let calls = 0;
    authoringScript = (input) => {
      calls += 1;
      if (calls === 1)
        return Stream.make(AiResponse.makePart("text-delta", { id: "t1", delta: firstRound })).pipe(
          Stream.concat(authoringTool(input, "list_agent_options", { kind: "models" })),
        ) as Stream.Stream<ChatStreamPart>;
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t2", delta: secondRound }),
        authoringFinish(),
      ) as Stream.Stream<ChatStreamPart>;
    };
    yield* engine.startGeneration({
      userId: seed.userId,
      conversationId: seed.conversation.id,
      messageId: seed.assistant.id,
      generationId: seed.assistant.generationId ?? undefined,
      modelId: textModelId,
      searchEnabled: false,
    });
    yield* waitForAnswer(seed.assistant.id);
    authoringScript = null;
    const steer = (yield* repo.listMessages(seed.conversation.id)).find(
      (message) => message.steeredIntoMessageId,
    )!;
    return { seed, file, steer, promptsBefore };
  });

  it("steers a queued message with a file into the running answer at a model boundary", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const { seed, steer, promptsBefore } = yield* steeredConversation;
        return {
          final: yield* repo.getMessage(seed.assistant.id),
          order: (yield* repo.listMessages(seed.conversation.id)).map((message) => message.role),
          steer,
          continuation: JSON.stringify(streamPrompts[promptsBefore + 1]?.content),
          calls: streamPrompts.length - promptsBefore,
          steeredFiles: (yield* attachmentRepo.listForMessages([steer.id])).map(
            (row) => row.fileName,
          ),
          queue: yield* repo.listQueue(seed.conversation.id),
          chunks: yield* repo.chunksAfter(seed.assistant.id, 0),
        };
      }),
    );

    // In the stream where it was taken in: after the first round's text and
    // tool, before the second round's text, so live and replay agree.
    const kinds = result.chunks.map((chunk) => chunk.kind);
    const steerAt = kinds.indexOf("steer");
    expect(kinds.lastIndexOf("tool")).toBeLessThan(steerAt);
    expect(result.chunks[steerAt + 1]).toMatchObject({ kind: "text", delta: secondRound });
    expect(JSON.parse(result.chunks[steerAt]!.delta)).toMatchObject({
      id: result.steer.id,
      content: "use a different ending",
      textOffset: firstRound.length,
      attachments: [{ fileName: "steer.txt" }],
    });

    expect(result.final?.status).toBe("complete");
    // One answer, continued rather than restarted: both calls stream into it.
    expect(result.calls).toBe(2);
    expect(result.final?.content).toBe(firstRound + secondRound);
    // The continuation read the steered file, not just its words.
    expect(result.continuation).toContain("Steer file body 42");
    expect(result.continuation).toContain("use a different ending");
    // It arrived after the first round's text and tool, which is where it is drawn.
    expect(result.steer).toMatchObject({
      content: "use a different ending",
      steeredIntoMessageId: result.final?.id,
      steerTextOffset: firstRound.length,
      steerTurnIndex: 0,
    });
    // Its real time, just after the answer it went into; readers of the last
    // turn skip it, and a rewind of that answer takes it by position.
    expect(result.order).toEqual(["user", "assistant", "user"]);
    expect(result.steeredFiles).toEqual(["steer.txt"]);
    expect(result.queue).toEqual([]);
  }, 60_000);

  it("places a steer between replayed turns for an image-output model", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "make it a dog",
          attachmentIds: [],
          input: { ...queuedInput(), modelId: imageModelId },
        });
        yield* repo.steerQueueEntry({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        });
        let calls = 0;
        authoringScript = (input) => {
          calls += 1;
          if (calls === 1)
            return Stream.make(
              AiResponse.makePart("text-delta", { id: "t1", delta: "Drawing a cat. " }),
            ).pipe(
              Stream.concat(authoringTool(input, "list_agent_options", { kind: "models" })),
            ) as Stream.Stream<ChatStreamPart>;
          return Stream.make(
            AiResponse.makePart("text-delta", {
              id: "t2",
              delta: calls === 2 ? "Here is the dog." : "Another one.",
            }),
            authoringFinish(),
          ) as Stream.Stream<ChatStreamPart>;
        };
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId ?? undefined,
          modelId: imageModelId,
          searchEnabled: false,
        });
        yield* waitForAnswer(seed.assistant.id);
        const continuation = streamPrompts.at(-1)!.content;
        const sent = yield* chat.sendMessage({
          userId: seed.userId,
          conversation: { kind: "existing", id: seed.conversation.id },
          modelId: imageModelId,
          content: "and another",
          attachmentIds: [],
          searchEnabled: false,
          researchEnabled: false,
        });
        yield* waitForAnswer(sent.assistantMessageId);
        authoringScript = null;
        return {
          replay: (yield* repo.getMessage(seed.assistant.id))?.providerReplay?.turns.map(
            (turn) => turn.turnIndex,
          ),
          continuation,
          history: streamPrompts.at(-1)!.content,
        };
      }),
    );

    // One replay turn per model call, so later history is rebuilt from them.
    expect(result.replay).toEqual([0, 1]);
    // Live: the round's call and results, then the steer, then the next call.
    expect(promptShape(result.continuation).slice(-3)).toEqual([
      "assistant:turn0",
      "tool",
      "user:steer",
    ]);
    // Next turn: the same order rebuilt from the replay turns.
    const history = promptShape(result.history);
    const at = history.indexOf("assistant:turn0");
    expect(history.slice(at, at + 4)).toEqual([
      "assistant:turn0",
      "tool",
      "user:steer",
      "assistant:turn1",
    ]);
  }, 60_000);

  it("gives later turns the steer inside the answer it changed", async () => {
    const prompt = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const { seed } = yield* steeredConversation;
        const sent = yield* chat.sendMessage({
          userId: seed.userId,
          conversation: { kind: "existing", id: seed.conversation.id },
          modelId: textModelId,
          content: "and now a haiku",
          attachmentIds: [],
          searchEnabled: false,
          researchEnabled: false,
        });
        yield* waitForAnswer(sent.assistantMessageId);
        return streamPrompts.at(-1)!.content;
      }),
    );

    const turns = prompt
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => `${message.role}:${JSON.stringify(message.content)}`);
    const at = (text: string) => turns.findIndex((turn) => turn.includes(text));
    const steerAt = at("use a different ending");
    // The answer so far, the steer with its file, then the rest of the answer.
    expect(turns[steerAt]).toContain("Steer file body 42");
    expect(turns[steerAt - 1]).toMatch(/^assistant:.*Checking the models/);
    expect(turns[steerAt + 1]).toMatch(/^assistant:.*Here is the ending/);
    expect(turns[steerAt + 2]).toMatch(/^user:.*and now a haiku/);
    expect(turns.filter((turn) => turn.includes("use a different ending"))).toHaveLength(1);
  }, 60_000);

  it("takes the steer and its file with the answer when the question is edited", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const { seed, file } = yield* steeredConversation;
        yield* chat.editMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.userMessage.id,
          content: "hi, but shorter",
          modelId: textModelId,
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        });
        yield* waitForAnswer(seed.assistant.id);
        return {
          transcript: (yield* repo.listMessages(seed.conversation.id)).map(
            (message) => `${message.role}:${message.content}`,
          ),
          fileLeft: (yield* attachmentRepo.listWithBlobsByIds(seed.userId, [file.id])).length,
        };
      }),
    );

    // The steer was part of the attempt the edit replaced.
    expect(result.transcript).toEqual(["user:hi, but shorter", `assistant:${oneRound}`]);
    expect(result.fileLeft).toBe(0);
  }, 60_000);

  it("points a branch's copied steer at the copied answer", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { seed } = yield* steeredConversation;
        const branch = yield* repo.cloneConversationPrefix({
          userId: seed.userId,
          sourceConversationId: seed.conversation.id,
          throughMessageId: seed.assistant.id,
        });
        const copied = yield* repo.listMessages(branch.id);
        return {
          // The steer sorts after the answer, so a branch through the answer
          // has to reach past it to keep the steer.
          answerId: copied.find((message) => message.role === "assistant")!.id,
          steer: copied.find((message) => message.steeredIntoMessageId),
        };
      }),
    );

    expect(result.steer).toMatchObject({
      content: "use a different ending",
      steeredIntoMessageId: result.answerId,
      steerTextOffset: firstRound.length,
    });
  }, 60_000);

  it("never bolts a steer onto an answer that ends without another step", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const older = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "queued first",
          attachmentIds: [],
          input: queuedInput(),
        });
        const steered = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "steered later",
          attachmentIds: [],
          input: queuedInput(),
        });
        yield* repo.steerQueueEntry({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: steered.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        });
        // The fake model answers in one call with no tools: no boundary comes.
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId ?? undefined,
          modelId: textModelId,
          searchEnabled: false,
        });
        yield* waitForAnswer(seed.assistant.id);
        const queue = yield* repo.listQueue(seed.conversation.id);
        const promoted = yield* repo.promoteNextQueuedTurn({
          conversationId: seed.conversation.id,
          expectedEntryId: queue[0]!.id,
          resolve: () => () => Effect.succeed(PLAIN_GENERATION),
        });
        return {
          content: (yield* repo.getMessage(seed.assistant.id))?.content,
          steerRows: (yield* repo.listMessages(seed.conversation.id)).filter(
            (message) => message.steeredIntoMessageId,
          ).length,
          order: queue.map((entry) => entry.id),
          ids: { older: older.id, steered: steered.id },
          promoted: promoted.promoted ? promoted.userMessage.content : null,
        };
      }),
    );

    expect(result.content).toBe(oneRound);
    expect(result.steerRows).toBe(0);
    // Asked to go now, so it goes next, ahead of the message queued before it.
    expect(result.order).toEqual([result.ids.steered, result.ids.older]);
    expect(result.promoted).toBe("steered later");
  }, 60_000);

  it("stops the running answer and starts the chosen entry when sent now", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        // Work, so the answer it starts does not go on to start the other
        // entry when it finishes; the desktop fields below name its machine.
        const seed = yield* setupWorkConversation(setupConversation);
        yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "queued first",
          attachmentIds: [],
          input: queuedInput(),
        });
        const chosen = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "send this one now",
          attachmentIds: [],
          input: queuedInput(),
        });
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 2, reached, release };
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId ?? undefined,
          modelId: textModelId,
          searchEnabled: false,
        });
        yield* Deferred.await(reached);
        // The parked answer stays parked; only Stop may end it.
        hold = null;
        const sent = yield* chat.sendQueuedNow({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: chosen.id,
          desktop: { fromDesktop: true, desktopExecutorId: "executor-now" },
        });
        const next = (yield* repo.listMessages(seed.conversation.id)).at(-1)!;
        yield* waitForAnswer(next.id);
        return {
          sent,
          stopped: yield* repo.getMessage(seed.assistant.id),
          transcript: (yield* repo.listMessages(seed.conversation.id)).map(
            (message) => `${message.role}:${message.status}:${message.content.slice(0, 17)}`,
          ),
          queue: (yield* repo.listQueue(seed.conversation.id)).map((entry) => entry.content),
        };
      }),
    );

    expect(result.sent).toEqual({ started: true });
    // Stopped, keeping what it had written.
    expect(result.stopped?.status).toBe("aborted");
    // The gate holds the second word, so only the first was written.
    expect(result.stopped?.content).toBe("alpha ");
    expect(result.transcript).toEqual([
      "user:complete:hi",
      "assistant:aborted:alpha ",
      "user:complete:send this one now",
      "assistant:complete:alpha beta gamma ",
    ]);
    expect(result.queue).toEqual(["queued first"]);
  }, 60_000);

  it("lets only the live generation claim a steer, leaving it queued otherwise", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "change course",
          attachmentIds: [],
          input: queuedInput(),
        });
        yield* repo.steerQueueEntry({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        });
        const fence = {
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        };
        const claim = repo.claimSteeredEntries({
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          textOffset: 0,
          turnIndex: 0,
        });
        // A retried attempt holds a different generation id: its fence fails.
        const stale = yield* Effect.exit(
          claim.pipe(Effect.provideService(GenerationFence, { ...fence, generationId: uuidv7() })),
        );
        const afterStale = (yield* repo.listQueue(seed.conversation.id)).length;
        const claimed = yield* claim.pipe(Effect.provideService(GenerationFence, fence));
        return {
          staleInterrupted: Exit.hasInterrupts(stale),
          afterStale,
          claimed,
          queue: yield* repo.listQueue(seed.conversation.id),
        };
      }),
    );

    expect(result.staleInterrupted).toBe(true);
    expect(result.afterStale).toBe(1);
    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0]).toMatchObject({
      content: "change course",
      steeredIntoMessageId: expect.any(String),
    });
    expect(result.queue).toEqual([]);
  });

  it("waits for a desktop app to start queued Work, then runs on that app's executor", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const external = yield* ExternalCompletion;
        const db = yield* Db;
        const seed = yield* setupConversation;
        yield* db
          .update(conversations)
          .set({ mode: "work" })
          .where(eq(conversations.id, seed.conversation.id));
        yield* repo.finalizeMessage({
          messageId: seed.assistant.id,
          status: "complete",
          content: "done",
        });
        yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "run the tests",
          attachmentIds: [],
          input: queuedInput(),
        });
        // The server cannot name a live machine, so without one nothing starts.
        const withoutDesktop = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
        });
        const stillQueued = (yield* repo.listQueue(seed.conversation.id)).length;

        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 1, reached, release };
        const withDesktop = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          desktop: {
            fromDesktop: true,
            desktopExecutorId: "executor-now",
            deviceSessionId: "device-1",
          },
        });
        yield* Deferred.await(reached);
        const owners = yield* external.owners();
        const assistant = (yield* repo.listMessages(seed.conversation.id)).at(-1)!;
        const events = yield* Effect.forkChild(
          engine.subscribe(assistant.id, 0).pipe(Stream.runCollect),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(events);
        hold = null;
        return {
          withoutDesktop,
          stillQueued,
          withDesktop,
          owner: owners.find((owner) => owner.messageId === assistant.id),
          final: yield* repo.getMessage(assistant.id),
          queue: yield* repo.listQueue(seed.conversation.id),
        };
      }),
    );

    expect(result.withoutDesktop).toEqual({ started: false });
    expect(result.stillQueued).toBe(1);
    expect(result.withDesktop).toEqual({ started: true });
    expect(result.owner).toMatchObject({
      executorId: "executor-now",
      deviceSessionId: "device-1",
    });
    expect(result.final?.status).toBe("complete");
    expect(result.queue).toEqual([]);
  }, 60_000);
});

describe("resumable streaming pipeline", () => {
  it("terminalizes a committed attempt when configuration preflight fails", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const seed = yield* setupConversation;
        yield* db
          .delete(messageGenerationConfig)
          .where(eq(messageGenerationConfig.messageId, seed.assistant.id));
        yield* db.insert(messageChunks).values([
          { messageId: seed.assistant.id, seq: 1, kind: "text", delta: "partial " },
          { messageId: seed.assistant.id, seq: 2, kind: "reasoning", delta: "thought" },
          { messageId: seed.assistant.id, seq: 3, kind: "text", delta: "answer" },
        ]);
        const runningTool = uuidv7();
        const completedTool = uuidv7();
        yield* repo.insertToolCall({
          id: runningTool,
          messageId: seed.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "running-preflight",
          toolName: "web_search",
          arguments: {},
        });
        yield* repo.insertToolCall({
          id: completedTool,
          messageId: seed.assistant.id,
          turnIndex: 0,
          callIndex: 1,
          providerCallId: "completed-preflight",
          toolName: "web_search",
          arguments: {},
        });
        yield* repo.completeToolCall({ id: completedTool, status: "complete", result: {} });
        const runningCompaction = uuidv7();
        yield* repo.createCompactionEvent({
          id: runningCompaction,
          messageId: seed.assistant.id,
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
        });
        yield* engine.startGeneration({
          generationId: seed.assistant.generationId ?? undefined,
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          modelId: "fake",
          searchEnabled: false,
        });
        const events = yield* engine
          .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
          .pipe(Stream.runCollect, Effect.timeout("5 seconds"));
        return {
          events: Array.from(events),
          message: yield* repo.getMessage(seed.assistant.id),
          tools: yield* repo.listToolCalls([seed.assistant.id]),
          compactions: yield* repo.listCompactionEvents([seed.assistant.id]),
          ledger: yield* db
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.messageId, seed.assistant.id)),
        };
      }),
    );
    expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "error" });
    expect(result.message).toMatchObject({
      status: "error",
      content: "partial answer",
      reasoning: "thought",
    });
    expect(result.tools.map((call) => call.status)).toEqual(["error", "complete"]);
    expect(result.compactions.map((event) => event.status)).toEqual(["error"]);
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]).toMatchObject({ status: "error", usageComplete: false });
  });

  it("settles a desktop attempt when external registration fails", async () => {
    const external = await runtime.runPromise(ExternalCompletion);
    const track = vi
      .spyOn(external, "track")
      .mockImplementationOnce(() => Effect.die(new Error("desktop registration failed")));
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* StreamEngine;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const seed = yield* setupConversation;
          yield* engine.startGeneration({
            generationId: seed.assistant.generationId ?? undefined,
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            modelId: "fake",
            searchEnabled: false,
            desktopExecutorId: "test-executor",
          });
          const events = yield* engine
            .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
            .pipe(Stream.runCollect);
          return {
            events: Array.from(events),
            message: yield* repo.getMessage(seed.assistant.id),
            ledger: yield* db
              .select()
              .from(usageEvents)
              .where(eq(usageEvents.messageId, seed.assistant.id)),
          };
        }),
      );
      expect(track).toHaveBeenCalledOnce();
      expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "error" });
      expect(result.message?.status).toBe("error");
      expect(result.ledger).toMatchObject([{ status: "error", usageComplete: false }]);
    } finally {
      track.mockRestore();
    }
  });

  it("cannot settle activity or ledger through an older generation fence", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const seed = yield* setupConversation;
        yield* repo.insertToolCall({
          id: uuidv7(),
          messageId: seed.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "current-attempt",
          toolName: "web_search",
          arguments: {},
        });
        const stale = yield* Effect.exit(
          repo
            .failGeneration({
              messageId: seed.assistant.id,
              error: "old attempt failed",
              ledger: {
                userId: seed.userId,
                kind: "chat",
                modelId: null,
                modelName: "fake",
                conversationId: seed.conversation.id,
                messageId: seed.assistant.id,
                status: "error",
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                usageComplete: false,
                cost: null,
                costSource: null,
              },
            })
            .pipe(
              Effect.provideService(GenerationFence, {
                userId: seed.userId,
                conversationId: seed.conversation.id,
                messageId: seed.assistant.id,
                generationId: uuidv7(),
              }),
            ),
        );
        return {
          stale,
          message: yield* repo.getMessage(seed.assistant.id),
          tools: yield* repo.listToolCalls([seed.assistant.id]),
          ledger: yield* db
            .select()
            .from(usageEvents)
            .where(eq(usageEvents.messageId, seed.assistant.id)),
        };
      }),
    );
    expect(Exit.hasInterrupts(result.stale)).toBe(true);
    expect(result.message?.status).toBe("streaming");
    expect(result.tools[0]?.status).toBe("running");
    expect(result.ledger).toEqual([]);
  });

  it("loads the generation model once for capabilities and accounting", async () => {
    const providers = await runtime.runPromise(ProviderRepo);
    const lookup = vi.spyOn(providers, "getModel");
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* StreamEngine;
          const seed = yield* setupConversation;
          yield* engine.startGeneration({
            generationId: seed.assistant.generationId ?? undefined,
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            modelId: "fake",
            searchEnabled: false,
          });
          yield* engine.subscribe(seed.assistant.id, 0).pipe(Stream.runDrain);
        }),
      );
      expect(lookup).toHaveBeenCalledExactlyOnceWith("fake");
    } finally {
      lookup.mockRestore();
    }
  });

  it("does not label retry chunks with the previous generation during replay", async () => {
    const repo = await runtime.runPromise(ChatRepo);
    const db = await runtime.runPromise(Db);
    const seed = await runtime.runPromise(setupConversation);
    const nextRunId = uuidv7();
    const chunksAfter = repo.chunksAfter;
    const replayRead = vi.spyOn(repo, "chunksAfter").mockImplementationOnce((messageId, afterSeq) =>
      Effect.gen(function* () {
        // Commit the retry replacement exactly between the identity and chunk reads.
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(messages)
              .set({ generationId: nextRunId, status: "complete" })
              .where(eq(messages.id, messageId));
            yield* tx.delete(messageChunks).where(eq(messageChunks.messageId, messageId));
            yield* tx
              .insert(messageChunks)
              .values({ messageId, seq: 1, kind: "text", delta: "new attempt" });
          }),
        );
        return yield* chunksAfter(messageId, afterSeq);
      }).pipe(Effect.orDie),
    );
    try {
      const events = await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          engine
            .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
            .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("10 seconds")),
        ),
      );
      expect(Array.from(events)).toEqual([
        { kind: "done", messageId: seed.assistant.id, runId: nextRunId, status: "error" },
      ]);
      expect(replayRead).toHaveBeenCalledTimes(1);
    } finally {
      replayRead.mockRestore();
    }
  });

  it.each(["ledger", "conversation"] as const)(
    "settles live subscribers when the final %s write fails",
    async (target) => {
      const seed = await runtime.runPromise(setupConversation);
      const table = target === "ledger" ? "usage_events" : "conversations";
      const condition =
        target === "ledger"
          ? `NEW.message_id = '${seed.assistant.id}' AND NEW.status = 'complete'`
          : `NEW.id = '${seed.conversation.id}' AND EXISTS (SELECT 1 FROM messages WHERE id = '${seed.assistant.id}' AND status = 'complete')`;
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.execute(
            sql.raw(`CREATE FUNCTION reject_terminal_write() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF ${condition} THEN RAISE EXCEPTION 'injected finalization failure'; END IF;
            RETURN NEW;
          END $$`),
          );
          yield* db.execute(
            sql.raw(`CREATE TRIGGER reject_terminal_write BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION reject_terminal_write()`),
          );
        }),
      );
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const engine = yield* StreamEngine;
            const repo = yield* ChatRepo;
            const db = yield* Db;
            const reached = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            hold = { after: 2, reached, release };
            yield* engine.startGeneration({
              generationId: seed.assistant.generationId ?? undefined,
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: seed.assistant.id,
              modelId: "fake",
              searchEnabled: false,
            });
            const events = yield* engine.subscribe(seed.assistant.id, 0).pipe(
              Stream.tap((event) =>
                event.kind === "chunk" ? Deferred.succeed(release, undefined) : Effect.void,
              ),
              Stream.runCollect,
              Effect.timeout("10 seconds"),
            );
            return {
              events: Array.from(events),
              final: yield* repo.getMessage(seed.assistant.id),
              ledger: yield* db
                .select()
                .from(usageEvents)
                .where(eq(usageEvents.messageId, seed.assistant.id)),
            };
          }),
        );
        expect(result.events.at(-1)).toMatchObject({ kind: "done", status: "error" });
        expect(result.final?.status).toBe("error");
        expect(result.final?.content).toBe("alpha beta gamma delta epsilon");
        expect(result.ledger).toHaveLength(1);
        expect(result.ledger[0]?.status).toBe("error");
      } finally {
        hold = null;
        await runtime.runPromise(
          Effect.gen(function* () {
            const db = yield* Db;
            yield* db.execute(sql.raw(`DROP TRIGGER reject_terminal_write ON ${table}`));
            yield* db.execute(sql.raw("DROP FUNCTION reject_terminal_write()"));
          }),
        );
      }
    },
    30_000,
  );

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
    // Contiguous from seq 1 and exactly the persisted content, since resume relies
    // on both, and the stop path has its own flush.
    expect(result.chunks.map((c) => c.seq)).toEqual(result.chunks.map((_, index) => index + 1));
    expect(result.chunks.map((c) => c.delta).join("")).toBe(result.final?.content);
  }, 60_000);

  it.each(["timer", "detail"] as const)(
    "notifies an existing subscriber when the %s reaper settles its generation",
    async (path) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* StreamEngine;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const seed = yield* setupConversation;
          yield* db.insert(messageChunks).values({
            messageId: seed.assistant.id,
            seq: 1,
            kind: "text",
            delta: "partial",
          });
          const subscribed = yield* Deferred.make<void>();
          const events = yield* Effect.forkChild(
            engine.subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined).pipe(
              Stream.tap((event) =>
                event.kind === "chunk" ? Deferred.succeed(subscribed, undefined) : Effect.void,
              ),
              Stream.runCollect,
              Effect.timeout("5 seconds"),
            ),
          );
          yield* Deferred.await(subscribed);
          yield* db
            .update(messages)
            .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(messages.id, seed.assistant.id));
          if (path === "detail") yield* loadConversationDetail(seed.userId, seed.conversation.id);
          else yield* engine.reapOrphans;
          return {
            events: Array.from(yield* Fiber.join(events)),
            message: yield* repo.getMessage(seed.assistant.id),
            generationId: seed.assistant.generationId,
          };
        }),
      );
      expect(result.events.at(-1)).toEqual({
        kind: "done",
        messageId: result.message?.id,
        runId: result.generationId,
        status: "error",
      });
      expect(result.message?.status).toBe("error");
    },
  );

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
            conversation: { kind: "existing", id: conversation.id },
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
          conversation: { kind: "existing", id: conversation.id },
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

  it("renews the lease while a generation is alive and never reaps it", async ({ signal }) => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const { userId, conversation, assistant } = yield* setupConversation;
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        hold = { after: 3, reached, release };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            hold = null;
          }).pipe(Effect.andThen(Deferred.interrupt(release))),
        );
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
        // Only an empty-batch heartbeat can advance this lease now. Expiring it
        // artificially would race the real background reaper, not test renewal.
        const [baseline] = yield* db
          .select({ lease: sql<string>`${messages.generationLeaseUntil}::text` })
          .from(messages)
          .where(eq(messages.id, assistant.id));
        // Preserve Postgres microseconds; a JS Date truncates them and would
        // make an unchanged lease appear newer than the baseline.
        expect(baseline?.lease).toBeTypeOf("string");
        yield* Effect.repeat(
          db
            .select({
              status: messages.status,
              renewed: sql<boolean>`${messages.generationLeaseUntil} > ${baseline!.lease} and ${messages.generationLeaseUntil} > clock_timestamp()`,
            })
            .from(messages)
            .where(eq(messages.id, assistant.id))
            .pipe(
              Effect.tap((rows) => Effect.sync(() => expect(rows[0]?.status).toBe("streaming"))),
              Effect.delay(Duration.millis(10)),
            ),
          { until: (rows) => rows[0]?.renewed === true },
        );
        yield* engine.reapOrphans;
        const during = yield* repo.getMessage(assistant.id);
        yield* Deferred.succeed(release, undefined);
        hold = null;
        const collected = yield* engine.subscribe(assistant.id, 0).pipe(Stream.runCollect);
        return { during, last: Array.from(collected).at(-1) };
      }).pipe(Effect.scoped),
      { signal },
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
            conversation: { kind: "existing", id: conversation.id },
            modelId: null as never,
            content,
            attachmentIds: [],
          });

        // The seeded assistant is still streaming, same rule as retry/edit.
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
    // The refused turn wrote nothing, just the seeded user + assistant.
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
        const ready = yield* Deferred.make<void>();
        const collect = bus.subscribe(userId).pipe(
          Stream.tap((event) =>
            event.type === "sync.ready" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.filter((event) => event.type !== "sync.ready"),
          Stream.take(1),
          Stream.runCollect,
        );
        const collector = yield* Effect.forkChild(collect);
        yield* Deferred.await(ready);
        yield* bus.publish(userId, { type: "conversation.created", conversationId: "c1" });
        return Array.from(yield* Fiber.join(collector));
      }),
    );
    expect(events).toEqual([{ type: "conversation.created", conversationId: "c1" }]);
  }, 30_000);
});

describe("scheduled turns", () => {
  it("fires into a fresh sidebar conversation and degrades a missing agent", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* setupConversation;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const db = yield* Db;
        const scheduleId = uuidv7();
        // The fallback is the user's default chat model, so make that
        // explicit rather than relying on the fixture's display-name order.
        yield* db.update(models).set({ defaultPriority: 1 }).where(eq(models.id, textModelId));
        yield* db.insert(schedules).values({
          id: scheduleId,
          userId: seed.userId,
          name: "Digest",
          prompt: "Summarize yesterday.",
          scheduleText: "every weekday at 7am",
          cron: "0 7 * * 1-5",
          timezone: "Europe/Berlin",
        });
        const turn = yield* chat.runScheduledTurn({
          userId: seed.userId,
          scheduleId,
          prompt: "Summarize yesterday.",
          // A saved model that no longer exists: the fire falls back rather
          // than failing an unattended schedule.
          modelId: "deleted-model",
          // Likewise an agent that was deleted after the schedule was saved.
          agentId: "deleted-agent",
          searchEnabled: false,
          researchEnabled: false,
          collectionIds: [],
          skillIds: [],
          timeZone: "Europe/Berlin",
          target: { kind: "new" },
        });
        yield* engine.subscribe(turn.assistantMessageId, 0).pipe(Stream.runDrain);
        const [conversation] = yield* db
          .select()
          .from(conversations)
          .where(eq(conversations.id, turn.conversationId));
        const listed = yield* repo.listConversations({ userId: seed.userId, limit: 50 });
        const answer = yield* repo.getMessage(turn.assistantMessageId);
        const defaults = yield* repo.getConversationDefaults(turn.conversationId);
        yield* db.update(models).set({ defaultPriority: null }).where(eq(models.id, textModelId));
        return {
          conversation,
          listed,
          answer,
          agent: defaults.agent,
          prompt: streamPrompts.at(-1)!,
        };
      }),
    );
    expect(result.conversation?.scheduleId).toBeTypeOf("string");
    // Listed like any chat, and marked as a schedule's.
    expect(result.listed.conversations.find((c) => c.id === result.conversation!.id)).toMatchObject(
      { scheduled: true },
    );
    expect(result.answer).toMatchObject({
      status: "complete",
      content: "alpha beta gamma delta epsilon",
      modelId: textModelId,
    });
    expect(result.agent).toBeNull();
    expect(JSON.stringify(result.prompt)).toContain("Time zone: Europe/Berlin");
  }, 60_000);

  it("fires a same-chat schedule into an existing chat, which keeps its agent", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* setupConversation;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const engine = yield* StreamEngine;
        const db = yield* Db;
        const scheduleId = uuidv7();
        yield* db.insert(schedules).values({
          id: scheduleId,
          userId: seed.userId,
          name: "Digest",
          prompt: "Summarize yesterday.",
          scheduleText: "every weekday at 7am",
          cron: "0 7 * * 1-5",
          timezone: "Europe/Berlin",
          chatMode: "same",
          chatId: seed.conversation.id,
        });
        // The fixture leaves its answer streaming; a fire would wait on it.
        yield* db
          .update(messages)
          .set({ status: "complete" })
          .where(eq(messages.id, seed.assistant.id));
        const count = () =>
          db
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.conversationId, seed.conversation.id))
            .pipe(Effect.map((rows) => rows.length));
        const before = yield* count();
        const fire = () =>
          chat.runScheduledTurn({
            userId: seed.userId,
            scheduleId,
            prompt: "Summarize yesterday.",
            modelId: textModelId,
            // Ignored for an existing chat: an agent cannot change after creation.
            agentId: "some-agent",
            searchEnabled: false,
            researchEnabled: false,
            collectionIds: [],
            skillIds: [],
            timeZone: "Europe/Berlin",
            target: { kind: "existing", conversationId: seed.conversation.id },
          });
        const first = yield* fire();
        yield* engine.subscribe(first.assistantMessageId, 0).pipe(Stream.runDrain);
        const second = yield* fire();
        yield* engine.subscribe(second.assistantMessageId, 0).pipe(Stream.runDrain);
        const after = yield* count();
        const [conversation] = yield* db
          .select()
          .from(conversations)
          .where(eq(conversations.id, seed.conversation.id));
        const listed = yield* repo.listConversations({ userId: seed.userId, limit: 50 });
        return {
          first,
          second,
          added: after - before,
          conversation,
          agent: (yield* repo.getConversationDefaults(seed.conversation.id)).agent,
          listed: listed.conversations.find((c) => c.id === seed.conversation.id),
        };
      }),
    );
    expect(result.first.conversationId).toBe(result.conversation!.id);
    expect(result.second.conversationId).toBe(result.conversation!.id);
    // Two runs, each a user prompt and an answer, in the one chat.
    expect(result.added).toBe(4);
    // Not created by the schedule, but marked as the one it runs in.
    expect(result.conversation?.scheduleId).toBeNull();
    expect(result.listed).toMatchObject({ scheduled: true });
    expect(result.agent).toBeNull();
  }, 60_000);
});

describe("scheduled turns into a work chat", () => {
  it("refuses to fire into a work chat, which needs the desktop app", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* setupConversation;
        const chat = yield* ChatService;
        const db = yield* Db;
        yield* db
          .update(conversations)
          .set({ mode: "work" })
          .where(eq(conversations.id, seed.conversation.id));
        return yield* chat
          .runScheduledTurn({
            userId: seed.userId,
            scheduleId: uuidv7(),
            prompt: "Tidy the repo.",
            modelId: textModelId,
            agentId: null,
            searchEnabled: false,
            researchEnabled: false,
            collectionIds: [],
            skillIds: [],
            timeZone: "UTC",
            target: { kind: "existing", conversationId: seed.conversation.id },
          })
          .pipe(Effect.flip);
      }),
    );
    expect(result).toMatchObject({ reason: "a work chat cannot run a schedule" });
  }, 60_000);
});

describe("temporary chats", () => {
  it("refuses a temporary work chat before creating anything", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* setupConversation;
        const chat = yield* ChatService;
        const db = yield* Db;
        const id = uuidv7();
        const error = yield* chat
          .sendMessage({
            userId: seed.userId,
            conversation: { kind: "new", id, mode: "work", temporary: true },
            modelId: textModelId,
            content: "Tidy the repo.",
            attachmentIds: [],
            searchEnabled: false,
            researchEnabled: false,
          })
          .pipe(Effect.flip);
        const rows = yield* db.select().from(conversations).where(eq(conversations.id, id));
        return { error, rows };
      }),
    );
    expect(result.error).toMatchObject({ reason: "a work chat cannot be temporary" });
    expect(result.rows).toEqual([]);
  }, 60_000);
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
          conversation: { kind: "existing", id: conversation.id },
          modelId: textModelId,
          content: "What day is it?",
          searchEnabled: false,
          researchEnabled: false,
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
          researchEnabled: false,
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
    // Editing changes the latest user turn, not the earlier UTC-annotated
    // history. Trailing context (skill catalogue, clock) follows that turn, so
    // find it rather than assume it sits right before the clock.
    const editedAt = streamPrompts[2]!.content.findIndex((message) =>
      JSON.stringify(message).includes("; edited:"),
    );
    expect(editedAt).toBeGreaterThan(-1);
    expect(streamPrompts[2]!.content.slice(0, editedAt)).toEqual(
      streamPrompts[0]!.content.slice(0, editedAt),
    );
    expect(JSON.stringify(streamPrompts[2]!.content[editedAt])).toContain("What time is it?");
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
    // The switch is for this attempt only, so the composer's default is untouched.
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

describe("reasoning effort attempts", () => {
  it("persists and replays effort, clears it on an unsupported retry model, and rejects invalid sends before writes", async () => {
    const observed: Array<string | null | undefined> = [];
    authoringScript = (input) => {
      observed.push(input.reasoningEffort);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatService;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const providers = yield* ProviderRepo;
          const engine = yield* StreamEngine;
          const seed = yield* seedAnswered(textModelId);
          const base = (yield* providers.getModel(textModelId))!;
          const reasoningModelId = uuidv7();
          yield* db.insert(models).values({
            id: reasoningModelId,
            providerId: base.providerId,
            modelKey: `reasoning-${reasoningModelId}`,
            displayName: "Reasoning test model",
            type: "chat",
            capabilities: {
              reasoning: true,
              reasoningEfforts: ["low", "high"],
              tools: false,
              vision: false,
              files: false,
            },
          });
          const submission = {
            userId: seed.userId,
            conversation: { kind: "existing" as const, id: seed.conversation.id },
            modelId: reasoningModelId,
            content: "Explain this.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          };
          const rejected = yield* chat
            .sendMessage({ ...submission, reasoningEffort: "max" })
            .pipe(Effect.flip);
          const before = yield* repo.listMessages(seed.conversation.id);
          const sent = yield* chat.sendMessage({ ...submission, reasoningEffort: "high" });
          yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
          const saved = yield* repo.getGenerationConfig(sent.assistantMessageId);
          yield* chat.retryMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: sent.assistantMessageId,
          });
          yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
          const replayed = yield* repo.getGenerationConfig(sent.assistantMessageId);
          const branch = yield* repo.cloneConversationPrefix({
            userId: seed.userId,
            sourceConversationId: seed.conversation.id,
            throughMessageId: sent.assistantMessageId,
          });
          const branchAnswer = (yield* repo.listMessages(branch.id))
            .filter((message) => message.role === "assistant")
            .at(-1)!;
          const branched = yield* repo.getGenerationConfig(branchAnswer.id);
          yield* chat.retryMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: sent.assistantMessageId,
            modelId: visionModelId,
          });
          yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
          const switched = yield* repo.getGenerationConfig(sent.assistantMessageId);
          const userMessage = (yield* repo.listMessages(seed.conversation.id)).find(
            (message) => message.content === "Explain this.",
          )!;
          const edited = yield* chat.editMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: userMessage.id,
            modelId: reasoningModelId,
            content: "Explain this again.",
            searchEnabled: false,
            researchEnabled: false,
            reasoningEffort: null,
            attachmentIds: [],
          });
          yield* engine.subscribe(edited.assistantMessageId, 0).pipe(Stream.runDrain);
          const cleared = yield* repo.getGenerationConfig(edited.assistantMessageId);
          return { rejected, before, saved, replayed, branched, switched, cleared };
        }),
      );
      expect(result.rejected).toMatchObject({ _tag: "InvalidMessage" });
      expect(result.before).toHaveLength(2);
      expect(result.saved.reasoningEffort).toBe("high");
      expect(result.replayed.reasoningEffort).toBe("high");
      expect(result.branched.reasoningEffort).toBe("high");
      expect(result.switched.reasoningEffort).toBeNull();
      expect(result.cleared.reasoningEffort).toBeNull();
      expect(observed).toEqual(["high", "high", null, null]);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("inherits an effort for question answers and honors an explicit default", async () => {
    const observed: Array<string | null | undefined> = [];
    authoringScript = (input) => {
      observed.push(input.reasoningEffort);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatService;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const engine = yield* StreamEngine;
          const seed = yield* seedAnswered(textModelId);
          const providerId = (yield* (yield* ProviderRepo).getModel(textModelId))!.providerId;
          const modelId = uuidv7();
          yield* db.insert(models).values({
            id: modelId,
            providerId,
            modelKey: `reasoning-${modelId}`,
            displayName: "Reasoning question model",
            type: "chat",
            capabilities: {
              reasoning: true,
              reasoningEfforts: ["high"],
              tools: true,
              vision: false,
              files: false,
            },
          });
          const sent = yield* chat.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId,
            content: "Choose a style",
            attachmentIds: [],
            searchEnabled: false,
            researchEnabled: false,
            reasoningEffort: "high",
          });
          yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
          const ask = (messageId: string) =>
            Effect.gen(function* () {
              const callId = uuidv7();
              yield* repo.insertToolCall({
                id: callId,
                messageId,
                turnIndex: 0,
                callIndex: 0,
                textOffset: 0,
                providerCallId: `ask-${callId}`,
                toolName: "ask_user",
                arguments: questionParams,
              });
              yield* repo.completeToolCall({
                id: callId,
                status: "complete",
                result: { v: 1, outcome: "presented", ...questionParams },
              });
              return callId;
            });
          const answer = (callId: string, reasoningEffort?: "high" | null) =>
            chat.sendMessage({
              userId: seed.userId,
              conversation: { kind: "existing", id: seed.conversation.id },
              modelId,
              questionResponse: { callId, response: { kind: "skip" } },
              attachmentIds: [],
              searchEnabled: false,
              researchEnabled: false,
              reasoningEffort,
            });
          const inherited = yield* answer(yield* ask(sent.assistantMessageId));
          yield* engine.subscribe(inherited.assistantMessageId, 0).pipe(Stream.runDrain);
          const inheritedConfig = yield* repo.getGenerationConfig(inherited.assistantMessageId);
          const cleared = yield* answer(yield* ask(inherited.assistantMessageId), null);
          yield* engine.subscribe(cleared.assistantMessageId, 0).pipe(Stream.runDrain);
          const clearedConfig = yield* repo.getGenerationConfig(cleared.assistantMessageId);
          return { inheritedConfig, clearedConfig };
        }),
      );
      expect(result.inheritedConfig.reasoningEffort).toBe("high");
      expect(result.clearedConfig.reasoningEffort).toBeNull();
      expect(observed).toEqual(["high", "high", null]);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("rejects an effort before writing when the provider transport cannot send it", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const seed = yield* seedAnswered(textModelId);
        const providerId = uuidv7();
        const modelId = uuidv7();
        yield* db.execute(sql`insert into providers (id, name, kind, base_url, api_key_ciphertext)
          values (${providerId}, 'unsupported-effort', 'openai-compatible', 'http://x', 'x')`);
        yield* db.insert(models).values({
          id: modelId,
          providerId,
          modelKey: `unsupported-${modelId}`,
          displayName: "Unsupported transport",
          type: "chat",
          capabilities: {
            reasoning: true,
            reasoningEfforts: ["high"],
            tools: false,
            vision: false,
            files: false,
          },
        });
        const failure = yield* chat
          .sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId,
            content: "Explain this",
            attachmentIds: [],
            searchEnabled: false,
            researchEnabled: false,
            reasoningEffort: "high",
          })
          .pipe(Effect.flip);
        return { failure, messages: yield* repo.listMessages(seed.conversation.id) };
      }),
    );
    expect(result.failure).toMatchObject({ _tag: "InvalidMessage" });
    expect(result.messages).toHaveLength(2);
  }, 60_000);

  it("revalidates a queued effort at promotion and falls back to provider default", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const chat = yield* ChatService;
        const providers = yield* ProviderRepo;
        const engine = yield* StreamEngine;
        const seed = yield* seedAnswered(textModelId);
        const base = (yield* providers.getModel(textModelId))!;
        const reasoningModelId = uuidv7();
        const capabilities = {
          reasoning: true,
          reasoningEfforts: ["high" as const],
          tools: false,
          vision: false,
          files: false,
        };
        yield* db.insert(models).values({
          id: reasoningModelId,
          providerId: base.providerId,
          modelKey: `queued-reasoning-${reasoningModelId}`,
          displayName: "Queued reasoning model",
          type: "chat",
          capabilities,
        });
        yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "Queued question",
          attachmentIds: [],
          input: {
            modelId: reasoningModelId,
            searchEnabled: false,
            researchEnabled: false,
            reasoningEffort: "high",
          },
        });
        yield* db
          .update(models)
          .set({ capabilities: { ...capabilities, reasoningEfforts: ["low"] } })
          .where(eq(models.id, reasoningModelId));
        const dispatched = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
        });
        const assistant = (yield* repo.listMessages(seed.conversation.id)).at(-1)!;
        yield* engine.subscribe(assistant.id, 0).pipe(Stream.runDrain);
        return {
          dispatched,
          entries: yield* repo.listQueue(seed.conversation.id),
          config: yield* repo.getGenerationConfig(assistant.id),
        };
      }),
    );
    expect(result.dispatched).toMatchObject({ started: true });
    expect(result.entries).toHaveLength(0);
    expect(result.config?.reasoningEffort).toBeNull();
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
          const initialId = initial!.assistantOutput!.files[0]!.attachment.id;

          const edit = yield* repo.createTurn({
            userId,
            conversation: { kind: "existing", id: conversation.id },
            modelId: imageModelId,
            content: "Replace the original image with a blue image",
            attachmentIds: [],
          });
          nextGeneratedImage = editedPng;
          const editedEvents = yield* run(edit.assistant);
          const edited = yield* repo.getMessage(edit.assistant.id);
          expect(edited!.status).toBe("complete");
          const editedId = edited!.assistantOutput!.files[0]!.attachment.id;
          expect(editedId).not.toBe(initialId);
          const event = editedEvents.find(
            (event) => event.kind === "chunk" && event.chunkKind === "file",
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
              .files[0]!.attachment.id,
          ).toBe(initialId);
          expect(
            detail.messages.find((message) => message.id === edit.assistant.id)!.assistantOutput!
              .files[0]!.attachment.id,
          ).toBe(editedId);

          const followup = yield* repo.createTurn({
            userId,
            conversation: { kind: "existing", id: conversation.id },
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
        ).toEqual(["text", "file", "text"]);
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
          assistantOutput: { files: [{ textOffset: 6, turnIndex: 0 }] },
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
            expect(message?.assistantOutput?.files.length ?? 0).toBe(image ? 1 : 0);
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

describe("custom tool calls", () => {
  const reply = () =>
    Stream.make(
      AiResponse.makePart("text-delta", { id: "t", delta: "Nothing to look up." }),
      authoringFinish(),
    );

  it("treats an invented custom_ name as an unknown tool rather than failing the attempt", async () => {
    const seed = await runtime.runPromise(setupConversation);
    const conversationId = (
      await runtime.runPromise(
        ChatRepo.use((repo) =>
          repo.createConversation({ userId: seed.userId, modelId: textModelId }),
        ),
      )
    ).id;
    let round = 0;
    // Nothing is pinned to this attempt, so the name has no manifest entry.
    // The SDK still forwards the part; the engine must not throw on it.
    authoringScript = () =>
      ++round === 1
        ? (Stream.make(
            AiResponse.makePart("tool-call", {
              id: uuidv7(),
              name: "custom_nope__lookup",
              params: {},
              providerExecuted: false,
            }),
            authoringFinish("tool-calls"),
          ) as Stream.Stream<ChatStreamPart>)
        : reply();
    try {
      const { assistantMessageId } = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content: "Look it up.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runCollect(engine.subscribe(assistantMessageId, 0)),
        ),
      );
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      expect(detail.messages.at(-1)).toMatchObject({ status: "complete" });
      expect(detail.toolCalls).toEqual([]);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("stores a tool's files as attachments of the answer and shares only what it asked to", async () => {
    const seed = await runtime.runPromise(setupConversation);
    const pdf = Buffer.from("%PDF-1.4 minimal");
    const csv = Buffer.from("a,b\n1,2\n");
    customToolRun = () =>
      Effect.succeed({
        ok: true,
        output: "Generated the report.",
        logs: [],
        durationMs: 1,
        files: [
          { name: "q3.pdf", mediaType: "application/pdf", share: false, bytes: pdf },
          { name: "q3.csv", mediaType: "text/csv", share: true, bytes: csv },
        ],
      });
    const created = await runtime.runPromise(
      CustomToolRepo.use((repo) =>
        repo.create({
          slug: `report_${seed.userId.slice(-8)}`,
          name: "Report",
          description: "",
          createdBy: seed.userId,
          build: {
            source: "",
            dependencies: [],
            compiled: "",
            functions: [
              {
                key: "make",
                name: "Make report",
                description: "Make the report.",
                modelName: `custom_report_${seed.userId.slice(-8)}__make`,
                parametersSchema: { type: "object", properties: {} },
              },
            ],
          },
        }),
      ),
    );
    const conversationId = (
      await runtime.runPromise(
        ChatRepo.use((repo) =>
          repo.createConversation({ userId: seed.userId, modelId: textModelId }),
        ),
      )
    ).id;
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return prompts.length === 1
        ? authoringTool(input, created.functions[0]!.modelName, {})
        : reply();
    };
    try {
      const { assistantMessageId } = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content: "Make me the Q3 report.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      const events = Array.from(
        await runtime.runPromise(
          Effect.flatMap(StreamEngine, (engine) =>
            Stream.runCollect(engine.subscribe(assistantMessageId, 0)),
          ),
        ),
      );
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const answer = detail.messages.at(-1)!;
      expect(answer.status).toBe("complete");
      // Both files are attachments of the answer, anchored where the tool ran.
      const stored = detail.attachments.filter((row) => row.messageId === assistantMessageId);
      expect(stored.map((row) => [row.fileName, row.kind])).toEqual([
        ["q3.pdf", "pdf"],
        ["q3.csv", "text"],
      ]);
      expect(answer.assistantOutput?.files.map((file) => file.origin)).toEqual([
        { toolCallId: expect.any(String) },
        { toolCallId: expect.any(String) },
      ]);
      expect(
        events.filter((event) => event.kind === "chunk" && event.chunkKind === "file"),
      ).toHaveLength(2);
      // The tool row names its files; the transcript result carries names only.
      const call = detail.toolCalls.find((row) => row.messageId === assistantMessageId)!;
      expect(call.result).toMatchObject({ fileIds: stored.map((row) => row.id) });
      expect(JSON.stringify(call.result)).not.toContain(csv.toString("base64"));
      // The model is handed each file's attachment id, the handle
      // save_to_workspace takes; the bytes stay on the server.
      const second = JSON.stringify(prompts[1]!.prompt);
      for (const row of stored) expect(second).toContain(`"attachmentId":"${row.id}"`);
      // Only the shared CSV reached the model's next round, as an inline fence.
      expect(second).toContain("1,2");
      expect(second).not.toContain("%PDF");
      expect(second).toContain('"name":"q3.pdf"');
    } finally {
      authoringScript = null;
      customToolRun = null;
    }
  }, 60_000);
});

describe("local tools on the user's machine", () => {
  const folder = { name: "acme-site", path: "/home/test/acme-site" };
  const workConversation = (userId: string) =>
    Effect.gen(function* () {
      const conversation = yield* (yield* ChatRepo).createConversation({
        userId,
        modelId: textModelId,
      });
      yield* (yield* Db)
        .update(conversations)
        .set({ mode: "work" })
        .where(eq(conversations.id, conversation.id));
      return conversation;
    });
  const desktopChat = Effect.gen(function* () {
    const seed = yield* setupConversation;
    return { ...seed, conversation: yield* workConversation(seed.userId) };
  });

  const send = (seed: Effect.Success<typeof desktopChat>, desktopCommands = false) =>
    Effect.flatMap(ChatService, (service) =>
      service.sendMessage({
        userId: seed.userId,
        conversation: { kind: "existing", id: seed.conversation.id },
        modelId: textModelId,
        content: "What is in the readme?",
        searchEnabled: false,
        researchEnabled: false,
        attachmentIds: [],
        fromDesktop: true,
        desktopExecutorId: "desktop-test-session",
        desktopFolders: [folder],
        desktopCommands,
      }),
    );

  it("reserves without transcript rows and activates a proposed id exactly once", async () => {
    const promptsBefore = streamPrompts.length;
    authoringScript = () =>
      Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Ready." }),
        authoringFinish(),
      );
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const { userId } = yield* setupConversation;
          const service = yield* ChatService;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const groupId = uuidv7();
          yield* db.insert(groups).values({
            id: groupId,
            name: `Work without attachments ${groupId}`,
            capabilities: { ...ALL_CAPABILITIES, attachments: false },
          });
          yield* db.insert(groupMembers).values({ groupId, userId });
          const conversationId = uuidv7();
          const reservationId = uuidv7();
          const conversation = { kind: "new" as const, id: conversationId, mode: "work" as const };
          yield* service.reserveWorkTurn({ id: reservationId, userId, conversation });

          const [beforeConversation, beforeMessages] = yield* Effect.all([
            db
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.id, conversationId)),
            db
              .select({ id: messages.id })
              .from(messages)
              .where(eq(messages.conversationId, conversationId)),
          ]);

          const input = {
            userId,
            reservationId,
            conversation,
            modelId: textModelId,
            content: "Read the staged report.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopFolders: [
              { name: "workspace", path: `/data/workspaces/${conversationId}` },
              folder,
            ],
            desktopCommands: true,
            workspaceFiles: ["report.pdf"],
          };
          const first = yield* service.sendMessage(input);
          const replay = yield* service.sendMessage(input);
          yield* (yield* StreamEngine).subscribe(first.assistantMessageId, 0).pipe(Stream.runDrain);
          const status = yield* service.getWorkTurnReservation({ userId, reservationId });
          const config = yield* repo.getGenerationConfig(first.assistantMessageId);
          return { beforeConversation, beforeMessages, first, replay, status, config };
        }),
      );

      expect(result.beforeConversation).toEqual([]);
      expect(result.beforeMessages).toEqual([]);
      expect(result.replay).toEqual(result.first);
      expect(result.status).toMatchObject({
        status: "activated",
        conversationId: result.first.conversationId,
        assistantMessageId: result.first.assistantMessageId,
      });
      expect(result.config.workspaceFiles).toEqual(["report.pdf"]);
      expect(result.config.desktopFolders).toEqual(["workspace", "acme-site"]);
      expect(JSON.stringify(result.config)).not.toContain("/data/workspaces/");
      expect(JSON.stringify(result.config)).not.toContain("/home/test/");
      expect(streamPrompts).toHaveLength(promptsBefore + 1);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("allows one live reservation and expires it by the database clock", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* desktopChat;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const firstId = uuidv7();
        const secondId = uuidv7();
        const conversation = { kind: "existing" as const, id: seed.conversation.id };
        const attempts = yield* Effect.all(
          [
            repo
              .reserveWorkTurn({ id: firstId, userId: seed.userId, conversation })
              .pipe(Effect.result),
            repo
              .reserveWorkTurn({ id: secondId, userId: seed.userId, conversation })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        const winner = attempts.find((attempt) => attempt._tag === "Success");
        const loser = attempts.find((attempt) => attempt._tag === "Failure");
        if (!winner || winner._tag !== "Success") return yield* Effect.die("No reservation won");
        yield* db
          .update(workTurnReservations)
          .set({ expiresAt: sql`now() - interval '1 second'` })
          .where(eq(workTurnReservations.id, winner.success.id));
        const expired = yield* repo.getWorkTurnReservation(seed.userId, winner.success.id);
        return { winner: winner.success, loser, expired };
      }),
    );

    expect(outcome.loser?._tag).toBe("Failure");
    if (outcome.loser?._tag === "Failure")
      expect(outcome.loser.failure._tag).toBe("ConversationBusy");
    expect(outcome.expired.status).toBe("expired");
  });

  it("fences retry, edit, and branch inside their mutation transactions", async () => {
    authoringScript = () =>
      Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Ready." }),
        authoringFinish(),
      );
    try {
      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const seed = yield* desktopChat;
          const service = yield* ChatService;
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const sent = yield* send(seed, true);
          yield* (yield* StreamEngine).subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
          const beforeMessages = yield* repo.listMessages(seed.conversation.id);
          const beforeConversations = yield* db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.userId, seed.userId));
          const userMessage = beforeMessages.find((message) => message.role === "user")!;
          const reservationId = uuidv7();
          yield* service.reserveWorkTurn({
            id: reservationId,
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
          });

          const retry = yield* service
            .retryMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: sent.assistantMessageId,
              fromDesktop: true,
              desktopExecutorId: "reservation-fence-retry",
              desktopCommands: true,
            })
            .pipe(Effect.result);
          const edit = yield* service
            .editMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: userMessage.id,
              modelId: textModelId,
              content: "Edited while reserved",
              searchEnabled: false,
              researchEnabled: false,
              attachmentIds: [],
              fromDesktop: true,
              desktopExecutorId: "reservation-fence-edit",
              desktopFolders: [folder],
              desktopCommands: true,
            })
            .pipe(Effect.result);
          const branch = yield* service
            .branchConversation({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: sent.assistantMessageId,
            })
            .pipe(Effect.result);
          const afterMessages = yield* repo.listMessages(seed.conversation.id);
          const afterConversations = yield* db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.userId, seed.userId));
          yield* service.abortWorkTurn({ userId: seed.userId, reservationId });
          return {
            failures: [retry, edit, branch].map((result) =>
              result._tag === "Failure" ? result.failure._tag : "Success",
            ),
            beforeMessages,
            afterMessages,
            beforeConversations,
            afterConversations,
          };
        }),
      );

      expect(outcome.failures).toEqual([
        "ConversationBusy",
        "ConversationBusy",
        "ConversationBusy",
      ]);
      expect(outcome.afterMessages).toEqual(outcome.beforeMessages);
      expect(outcome.afterConversations).toEqual(outcome.beforeConversations);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("rejects proposed-id collisions and reservations for another user's chat", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const owner = yield* desktopChat;
        const stranger = yield* setupConversation;
        const repo = yield* ChatRepo;
        const service = yield* ChatService;
        const ordinary = yield* service
          .sendMessage({
            userId: owner.userId,
            conversation: { kind: "new", id: owner.conversation.id, mode: "work" },
            modelId: textModelId,
            content: "Do not reuse this id.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "collision-test",
            desktopFolders: [folder],
            desktopCommands: true,
          })
          .pipe(Effect.result);
        const collision = yield* repo
          .reserveWorkTurn({
            id: uuidv7(),
            userId: owner.userId,
            conversation: { kind: "new", id: owner.conversation.id, mode: "work" },
          })
          .pipe(Effect.result);
        const foreign = yield* repo
          .reserveWorkTurn({
            id: uuidv7(),
            userId: stranger.userId,
            conversation: { kind: "existing", id: owner.conversation.id },
          })
          .pipe(Effect.result);
        return { ordinary, collision, foreign };
      }),
    );

    expect(outcome.ordinary._tag).toBe("Failure");
    if (outcome.ordinary._tag === "Failure")
      expect(outcome.ordinary.failure._tag).toBe("InvalidMessage");
    expect(outcome.collision._tag).toBe("Failure");
    if (outcome.collision._tag === "Failure")
      expect(outcome.collision.failure._tag).toBe("InvalidMessage");
    expect(outcome.foreign._tag).toBe("Failure");
    if (outcome.foreign._tag === "Failure")
      expect(outcome.foreign.failure._tag).toBe("ConversationNotFound");
  });

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
              if (reply !== null) {
                const owned = yield* external.inspect(envelope.callId);
                expect(owned).not.toBeNull();
                expect(yield* (yield* ChatRepo).isDesktopAttemptLive(owned!)).toBe(true);
                expect(
                  yield* external.claim(envelope.callId, {
                    ...owned!,
                    executorId: "other-machine",
                  }),
                ).toBeNull();
                const token = yield* external.claim(envelope.callId, owned!);
                expect(token).toBeTruthy();
                expect(yield* external.completeClaim(envelope.callId, owned!, token!, reply)).toBe(
                  true,
                );
              }
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

  it.each(["existing assistant", "missing assistant"])(
    "preserves current Work authority for structured answers and %s edits",
    async (path) => {
      authoringScript = () =>
        Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
          authoringFinish(),
        );
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const seed = yield* setupQuestion;
            const repo = yield* ChatRepo;
            const service = yield* ChatService;
            const engine = yield* StreamEngine;
            yield* (yield* Db)
              .update(conversations)
              .set({ mode: "work" })
              .where(eq(conversations.id, seed.conversation.id));
            const sent = yield* service.sendMessage({
              ...answerInput(seed),
              searchEnabled: false,
              researchEnabled: false,
              fromDesktop: true,
              desktopExecutorId: "answer-session",
              desktopFolders: [{ name: "answer-folder", path: "/home/test/answer-folder" }],
              desktopCommands: false,
            });
            yield* Stream.runDrain(engine.subscribe(sent.assistantMessageId, 0));
            expect(
              (yield* repo.getGenerationConfig(sent.assistantMessageId))?.desktopFolders,
            ).toEqual(["answer-folder"]);
            const rows = yield* repo.listMessages(seed.conversation.id);
            const answer = rows.find((row) => row.questionResponse)!;
            if (path === "missing assistant") yield* repo.deleteMessages([sent.assistantMessageId]);
            const edited = yield* service.editMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: answer.id,
              modelId: textModelId,
              attachmentIds: [],
              searchEnabled: false,
              researchEnabled: false,
              questionResponse: {
                kind: "answers",
                answers: [{ selected: [], custom: "Current choice" }],
              },
              fromDesktop: true,
              desktopExecutorId: "edit-answer-session",
              desktopFolders: [{ name: "edited-folder", path: "/home/test/edited-folder" }],
              desktopCommands: true,
            });
            yield* Stream.runDrain(engine.subscribe(edited.assistantMessageId, 0));
            const config = yield* repo.getGenerationConfig(edited.assistantMessageId);
            expect(config?.desktopFolders).toEqual(["edited-folder"]);
            expect(config?.desktopCommands).toBe(true);
            yield* repo.updateConversation(seed.conversation.id, { permissionLevel: "skip" });
            const branch = yield* repo.cloneConversationPrefix({
              userId: seed.userId,
              sourceConversationId: seed.conversation.id,
              throughMessageId: edited.assistantMessageId,
            });
            expect(branch.mode).toBe("work");
            expect(branch.permissionLevel).toBe("skip");
            expect(
              (yield* (yield* ExternalCompletion).snapshot(seed.userId, "edit-answer-session"))
                .calls,
            ).toEqual([]);
          }),
        );
      } finally {
        authoringScript = null;
      }
    },
  );

  it("uses current desktop capabilities for retries and edits, refusing browser retries before reset", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    const settle = (messageId: string) =>
      runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) => Stream.runDrain(engine.subscribe(messageId, 0))),
      );
    try {
      const sent = await runtime.runPromise(send(seed, true));
      await settle(sent.assistantMessageId);
      const before = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId)),
      );
      const refused = await runtime.runPromise(
        Effect.result(
          ChatService.use((service) =>
            service.retryMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: sent.assistantMessageId,
            }),
          ),
        ),
      );
      expect(refused._tag === "Failure" && refused.failure._tag).toBe("WorkDesktopRequired");
      expect(
        await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(sent.assistantMessageId))),
      ).toEqual(before);
      await runtime.runPromise(
        ChatService.use((service) =>
          service.retryMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: sent.assistantMessageId,
            fromDesktop: true,
            desktopExecutorId: "another-current-session",
            desktopCommands: false,
          }),
        ),
      );
      await settle(sent.assistantMessageId);
      const retried = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getGenerationConfig(sent.assistantMessageId)),
      );
      expect(retried?.desktopFolders).toBeNull();
      expect(retried?.desktopCommands).toBe(false);
      expect(Object.keys(prompts.at(-1)!.toolkit?.tools ?? {})).not.toContain("read_local_file");
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      const userMessage = detail.messages.find((m) => m.role === "user")!;
      await runtime.runPromise(
        ChatService.use((service) =>
          service.editMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: userMessage.id,
            modelId: textModelId,
            content: "Edited instruction",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "current-edit-session",
            desktopFolders: [{ name: "current-folder", path: "/home/test/current-folder" }],
            desktopCommands: true,
          }),
        ),
      );
      await settle(sent.assistantMessageId);
      const edited = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getGenerationConfig(sent.assistantMessageId)),
      );
      expect(edited?.desktopFolders).toEqual(["current-folder"]);
      expect(edited?.desktopCommands).toBe(true);
      expect(Object.keys(prompts.at(-1)!.toolkit?.tools ?? {})).toContain("run_command");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it.each([false, true])(
    "folds local results into the next turn without persisting the body (Hermes: %s)",
    async (hermes) => {
      const seed = await runtime.runPromise(desktopChat);
      const prompts: GatewayInput[] = [];
      authoringScript = (input) => {
        prompts.push(input);
        if (prompts.length === 1)
          return authoringTool(input, "read_local_file", { path: "README.md" }, hermes);
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
        // The folder's real path reaches the prompt as the model's address;
        // only the name outlives the attempt, in the generation config.
        expect(JSON.stringify(prompts[0]!.prompt)).toContain(folder.path);

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
        expect(result.chunks.some((chunk) => chunk.delta.includes('"family":"desktop"'))).toBe(
          true,
        );
      } finally {
        authoringScript = null;
      }
    },
    60_000,
  );

  it("tells the model which files a send added to the workspace", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "A dump, plus two more." }),
        authoringFinish(),
      );
    };
    try {
      const sent = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "can you check whats in this file?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopFolders: [folder],
            workspaceFiles: ["dump.sql.gz"],
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(sent.assistantMessageId, 0)),
        ),
      );
      // The file is a name on the config row, and the prompt says what it
      // means: without the line, the model is never told the workspace gained
      // anything.
      const config = await runtime.runPromise(
        ChatRepo.use((repo) => repo.getGenerationConfig(sent.assistantMessageId)),
      );
      expect(config?.workspaceFiles).toEqual(["dump.sql.gz"]);
      expect(JSON.stringify(prompts[0]!.prompt)).toContain(
        "The user added this file to the workspace: dump.sql.gz",
      );

      const followUp = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "what was the file called?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopFolders: [folder],
            workspaceFiles: [],
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(followUp.assistantMessageId, 0)),
        ),
      );
      expect(JSON.stringify(prompts[1]!.prompt)).toContain(
        "The user added this file to the workspace: dump.sql.gz",
      );
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("hands an image to a vision model as a file part, never as text in the row", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "read_local_file", { path: "logo.png" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "A red square." }),
        authoringFinish(),
      );
    };
    const png = generatedPng.toString("base64");
    try {
      const sent = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: visionModelId,
            content: "What is in the logo?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopFolders: [folder],
          }),
        ),
      );
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(sent.assistantMessageId, () => ({
            v: 1,
            ok: true,
            summary: "Read logo.png",
            detail: "image/png, 70 bytes",
            truncated: false,
            file: { mediaType: "image/png", base64: png, name: "logo.png" },
          }));
          yield* Fiber.join(bridge.fiber);
          return {
            detail: yield* loadConversationDetail(seed.userId, seed.conversation.id),
            chunks: yield* ChatRepo.use((repo) => repo.chunksAfter(sent.assistantMessageId, 0)),
          };
        }),
      );
      expect(prompts).toHaveLength(2);
      // The bytes ride as a user file part on the round, the way an attached
      // image does, so the model can look at them.
      const second = prompts[1]!.prompt.content as ReadonlyArray<{
        role: string;
        content: unknown;
      }>;
      const fileMessage = second.find(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "file" && part.fileName === "logo.png"),
      );
      expect(fileMessage).toBeDefined();
      // And never as base64 inside the tool result, the row or a chunk.
      const toolResults = JSON.stringify(second.filter((message) => message.role === "tool"));
      expect(toolResults).not.toContain(png.slice(0, 40));
      expect(JSON.stringify(result.detail)).not.toContain(png.slice(0, 40));
      expect(JSON.stringify(result.chunks)).not.toContain(png.slice(0, 40));
      expect(result.detail.messages.at(-1)?.content).toContain("A red square.");
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

      expect(result.waited).toEqual({
        name: "run_command",
        args: { command: "pnpm test" },
      });
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

  it("settles active tool and compaction rows when finalization itself fails", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const repo = await runtime.runPromise(ChatRepo);
    authoringScript = (input) => authoringTool(input, "run_command", { command: "pnpm test" });
    let renewal: { mockRestore(): void } | undefined;
    try {
      const sent = await runtime.runPromise(send(seed, true));
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(sent.assistantMessageId, () => null);
          yield* Deferred.await(bridge.first);
          const before = yield* repo.listToolCalls([sent.assistantMessageId]);
          expect(before).toMatchObject([{ status: "running" }]);
          const compactionId = uuidv7();
          yield* repo.createCompactionEvent({
            id: compactionId,
            messageId: sent.assistantMessageId,
            beforeTurnIndex: 0,
            passIndex: 0,
            scope: "history",
          });
          renewal = vi
            .spyOn(repo, "renewGenerationLease")
            .mockImplementation(() => Effect.die(new Error("lease renewal failed")));
          yield* Fiber.join(bridge.fiber);
          const db = yield* Db;
          return {
            detail: yield* loadConversationDetail(seed.userId, seed.conversation.id),
            compactions: yield* repo.listCompactionEvents([sent.assistantMessageId]),
            ledger: yield* db
              .select()
              .from(usageEvents)
              .where(eq(usageEvents.messageId, sent.assistantMessageId)),
          };
        }),
      );
      expect(result.detail.messages.at(-1)?.status).toBe("error");
      expect(result.detail.toolCalls.at(-1)?.status).toBe("error");
      expect(result.compactions.at(-1)?.status).toBe("error");
      expect(result.ledger).toHaveLength(1);
    } finally {
      renewal?.mockRestore();
      authoringScript = null;
    }
  }, 60_000);

  /**
   * A development rebuild relaunches the app mid-call. It comes back with a new
   * executor id, so its own parked attempt is invisible to the snapshot and no
   * host can ever claim the call: without this the answer sat at "Writing ..."
   * for the whole change deadline.
   */
  it("ends the attempt a restarted app abandoned, sparing other devices", async () => {
    // The first round asks for the write every generation parks on; once the
    // handler reports the app is gone, the model answers in words, which is
    // what abandoning is for.
    const asked = new Set<string>();
    authoringScript = (input) => {
      const key = JSON.stringify(input.prompt).slice(-200);
      if (asked.has(key))
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Your desktop app closed." }),
          authoringFinish(),
        );
      asked.add(key);
      return authoringTool(input, "write_local_file", {
        path: `${folder.path}/note.md`,
        text: "hi",
      });
    };
    try {
      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const external = yield* ExternalCompletion;
          const engine = yield* StreamEngine;
          const service = yield* ChatService;
          const { userId } = yield* setupConversation;
          // One user, one executor id, three device sessions: the app that
          // restarts, a second device, and an attempt from before attempts
          // carried a device at all.
          const devices = ["device-1", "device-2", undefined] as const;
          const started = yield* Effect.forEach(devices, (deviceSessionId) =>
            Effect.gen(function* () {
              const conversation = yield* workConversation(userId);
              const sent = yield* service.sendMessage({
                userId,
                conversation: { kind: "existing", id: conversation.id },
                modelId: textModelId,
                content: "Write the note.",
                searchEnabled: false,
                researchEnabled: false,
                attachmentIds: [],
                fromDesktop: true,
                desktopExecutorId: "executor-1",
                deviceSessionId,
                desktopFolders: [folder],
              });
              return { conversation, messageId: sent.assistantMessageId };
            }),
          );
          // Nobody answers: every handler parks the way a closed app leaves it.
          const bridges = yield* Effect.forEach(started, (attempt) =>
            fakeBridge(attempt.messageId, () => null),
          );
          yield* Effect.forEach(bridges, (bridge) => Deferred.await(bridge.first));

          // The same device checks in again after its restart.
          yield* external.cancelSuperseded({
            userId,
            deviceSessionId: "device-1",
            executorId: "executor-2",
          });
          const live = yield* external.snapshot(userId, "executor-1");
          // Nothing is forced here: no lease is expired and no reaper is run,
          // so finishing at all is the proof that the released handler let the
          // generation carry on rather than dying with it.
          yield* Fiber.join(bridges[0]!.fiber);
          const detail = yield* loadConversationDetail(userId, started[0]!.conversation.id);
          const survivors = yield* Effect.forEach(started.slice(1), (attempt) =>
            ChatRepo.use((repo) => repo.getMessage(attempt.messageId)),
          );
          // Leaving two generations parked would outlive the suite.
          yield* Effect.forEach(started.slice(1), (attempt, index) =>
            Effect.gen(function* () {
              yield* engine.stopGeneration(
                attempt.messageId,
                survivors[index]?.generationId ?? undefined,
              );
              yield* Fiber.join(bridges[index + 1]!.fiber);
            }),
          );
          return { live, detail, survivors };
        }),
      );

      // The restarted device's attempt is the only one that lost authority.
      expect(outcome.live.attempts.map((attempt) => attempt.deviceSessionId)).toEqual([
        "device-2",
        undefined,
      ]);
      // The other device and the attempt with no device keep their deadline.
      expect(outcome.survivors.map((message) => message?.status)).toEqual([
        "streaming",
        "streaming",
      ]);
      // The call ends as the deadline would have ended it, but in seconds, and
      // the answer is a real one rather than an interrupted row.
      const call = outcome.detail.toolCalls.at(-1)!;
      expect(call.toolName).toBe("write_local_file");
      expect(call.status).toBe("error");
      expect(JSON.stringify(call.result)).toContain("may be closed");
      const message = outcome.detail.messages.at(-1)!;
      expect(message.status).toBe("complete");
      expect(message.content).toBe("Your desktop app closed.");
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
      expect(offered).toContain("save_to_workspace");
      expect(offered).not.toContain("run_command");
      // And the model is told, rather than left to discover it by trying.
      expect(JSON.stringify(prompts[0]!.prompt)).toContain("Running commands is unavailable");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("refuses a work chat from a browser, allows it without a folder, and stays a work chat", async () => {
    const seed = await runtime.runPromise(desktopChat);
    authoringScript = () =>
      Stream.make(AiResponse.makePart("text-delta", { id: "t", delta: "Hi." }), authoringFinish());
    try {
      // The first send creates the conversation and fixes its mode.
      const created = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "new", id: uuidv7(), mode: "work" },
            modelId: textModelId,
            content: "Start work.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopFolders: [folder],
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

      // A browser tab cannot say it is the desktop app. That is refused rather
      // than run as a plain chat.
      const refused = await runtime.runPromise(
        Effect.result(
          Effect.flatMap(ChatService, (service) =>
            service.sendMessage({
              userId: seed.userId,
              conversation: { kind: "existing", id: created.conversationId },
              modelId: textModelId,
              content: "Keep going.",
              searchEnabled: false,
              researchEnabled: false,
              attachmentIds: [],
            }),
          ),
        ),
      );
      expect(refused._tag === "Failure" && refused.failure._tag).toBe("WorkDesktopRequired");
      // Nothing was written: the refusal happened inside the turn, before rows.
      const after = await runtime.runPromise(
        loadConversationDetail(seed.userId, created.conversationId),
      );
      expect(after.messages).toHaveLength(detail.messages.length);

      // The desktop app without a folder is allowed; the folder tools wait.
      const prompts: GatewayInput[] = [];
      authoringScript = (input) => {
        prompts.push(input);
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Attach a folder and I can look." }),
          authoringFinish(),
        );
      };
      const bare = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: created.conversationId },
            modelId: textModelId,
            content: "Keep going.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            desktopCommands: false,
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(bare.assistantMessageId, 0)),
        ),
      );
      expect(Object.keys(prompts[0]!.toolkit?.tools ?? {})).not.toContain("read_local_file");

      // A later send cannot change the mode; a plain chat stays plain.
      const plainConversation = await runtime.runPromise(
        ChatRepo.use((repo) =>
          repo.createConversation({ userId: seed.userId, modelId: textModelId }),
        ),
      );
      const plain = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: plainConversation.id },
            modelId: textModelId,
            content: "Hello.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            fromDesktop: true,
            desktopExecutorId: "ignored-session",
            desktopFolders: [{ name: "ignored-folder", path: "/home/test/ignored-folder" }],
            desktopCommands: true,
          }),
        ),
      );
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(plain.assistantMessageId, 0)),
        ),
      );
      expect(
        (await runtime.runPromise(loadConversationDetail(seed.userId, plainConversation.id)))
          .conversation.mode,
      ).toBe("chat");
      expect(Object.keys(prompts.at(-1)!.toolkit?.tools ?? {})).not.toContain("read_local_file");
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
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Read my readme.",
            fromDesktop: true,
            desktopExecutorId: "desktop-test-session",
            searchEnabled: false,
            researchEnabled: false,
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
