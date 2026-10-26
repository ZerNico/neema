import { english, type Localized } from "~/i18n/localized.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { plainResolve, setAttemptSearch } from "./plain-resolve.ts";
import { createHash } from "node:crypto";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  Stream,
} from "effect";
import { uuidv7 } from "uuidv7";
import { LanguageModel, Response as AiResponse, type Prompt } from "effect/ai";
import { and, eq, or, sql } from "drizzle-orm";
import {
  conversationDrafts,
  conversations,
  conversationWorkingFiles,
  schedules,
  scheduleRuns,
  attachmentBlobs,
  conversationQueueEntries,
  attachments,
  messageAttachments,
  messageChunks,
  messageCompactionEvents,
  messageToolCalls,
  toolCallDebugArguments,
  messageGenerationConfig,
  messages,
  models,
  skills,
  skillRevisions,
  usageEvents,
  documentSteps,
  documents,
  projects,
  integrationConfigs,
  integrationConnections,
  conversationIntegrations,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { AgentDraftService } from "~/modules/agents/server/draft-service.ts";
import { EMPTY_AGENT_DRAFT } from "~/modules/agents/draft-schema.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import {
  CustomToolRuntime,
  type CustomToolRunResult,
} from "~/modules/custom-tools/server/runtime.ts";
import { toMarkdown } from "~/modules/documents/editor/markdown.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import type { DocumentFrame } from "~/modules/documents/schema.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { loadConversationDetail } from "~/modules/chat/server/conversation-detail.ts";
import { openMessageStream } from "~/modules/chat/server/message-stream.ts";
import { ASSISTANT_FILE_LIMITS } from "~/modules/chat/assistant-output.ts";
import { ChatRepo, PLAIN_GENERATION } from "~/modules/chat/server/repo.ts";
import { ComputerRepo } from "~/modules/computer/server/repo.ts";
import { MachineHub } from "~/modules/computer/server/hub.ts";
import { hashSource } from "~/modules/genui/fences.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { EditNotAllowed } from "~/modules/chat/errors.ts";
import { imageStandIn, RESUME_REMINDER } from "~/modules/chat/server/prompt.ts";
import {
  SettledCheckInterval,
  StreamEngine,
  type StreamEvent,
} from "~/modules/chat/server/streaming.ts";
import { KeptWorkingFiles } from "~/modules/chat/server/kept-working-files.ts";
import { GenerationFence, QueueSweepInterval } from "~/modules/chat/server/generation-fence.ts";
import { estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { SCHEDULE_AUTHORING_SKILL } from "~/modules/skills/bundled/index.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { hermesToolCalls } from "~/modules/providers/server/hermes-tools.ts";
import { askUserTool } from "~/modules/tools/server/ask-user.ts";
import {
  ExternalCompletion,
  type ExternalOperation,
} from "~/modules/tools/server/external-completion.ts";
import { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { collabEditor } from "../fixtures/collab-editor.ts";
import { FakeWebSearch } from "./unused-services.ts";
import { Db } from "~/server/db.ts";
import { outlastGrace } from "./purge.ts";
import { ImageFetcher, ImageFetchFailed } from "~/modules/genui/server/image-fetcher.ts";
import { ToolUnavailable, WebSearchExecutor } from "~/modules/tools/server/web-search.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { MapLookups } from "~/modules/genui/server/map-lookups.ts";
import { routeKey } from "~/modules/genui/extract.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";

// ProviderRepo decrypts stored keys through KeyCipher, which reads this.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

/** Image search for ```ui blocks; unset means web search is unavailable. */
let imageSearch: ((query: string) => ReadonlyArray<string>) | undefined;
const imageFetches: string[] = [];
const mapLookupCalls: string[] = [];
const ImageSearchingWebSearch = Layer.effect(
  WebSearchExecutor,
  Effect.gen(function* () {
    const base = yield* WebSearchExecutor;
    return WebSearchExecutor.of({
      ...base,
      images: (query) =>
        imageSearch
          ? Effect.succeed(
              imageSearch(query).map((url) => ({
                imageUrl: url,
                pageUrl: `${url}/page`,
                title: `Found ${url}`,
              })),
            )
          : Effect.fail(new ToolUnavailable({ tool: "web_search", reason: "disabled" })),
    });
  }),
).pipe(Layer.provide(FakeWebSearch));

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  | AgentRepo
  | AgentDraftService
  | CustomToolRepo
  | DocumentService
  | ChatRepo
  | ComputerRepo
  | MachineHub
  | ProviderRepo
  | ChatService
  | StreamEngine
  | SyncBus
  | Db
  | AttachmentRepo
  | AttachmentService
  | ExternalCompletion
  | ScheduleRepo
  | ToolsRepo
  | KeptWorkingFiles
  | ProjectFileService,
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
let customToolRun:
  | ((
      input: Parameters<CustomToolRuntime["Service"]["run"]>[0],
    ) => Effect.Effect<CustomToolRunResult>)
  | null = null;
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
/** A call whose arguments arrive in pieces, `pace` apart as a provider would send them. */
const streamedTool = (
  input: GatewayInput,
  name: string,
  params: unknown,
  pieces = 12,
  pace = Duration.zero,
) => {
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
          Stream.tap((part) =>
            part.type === "tool-params-delta" ? Effect.sleep(pace) : Effect.void,
          ),
          Stream.mapEffect((part) => encodePart(part)),
          Stream.orDie,
        ),
    }).pipe(
      Effect.map((model) => model.streamText({ prompt: input.prompt, toolkit: input.toolkit! })),
    ),
  ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
};
const authoringTool = (
  input: GatewayInput,
  name: string,
  params: unknown,
  hermes = false,
  /** Parts the round streams before its call. */
  lead: ReadonlyArray<AiResponse.AnyPart> = [],
) => {
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
        ...lead,
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
const gateway = {
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
              modelClient: {
                cost: 0.04,
                replay: {
                  v: 1,
                  id: "image-round",
                  identity: {
                    provider: "p",
                    baseUrl: "http://x",
                    format: "chat-completions",
                    model: "image-model",
                  },
                  format: "chat-completions",
                  reasoningDetails: [
                    { type: "reasoning.encrypted", data: "private-replay", id: "opaque" },
                  ],
                },
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
} satisfies Partial<AiGateway["Service"]>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const services = Layer.mergeAll(
    ImageSearchingWebSearch,
    Layer.succeed(MapLookups, {
      geocode: (_services, query) =>
        Effect.sync(() => {
          mapLookupCalls.push(`place:${query}`);
          return query.includes("Atlantis") ? [] : [{ lat: 52.5, lng: 13.4, name: query }];
        }),
      route: (_services, mode, stops) =>
        Effect.sync(() => {
          mapLookupCalls.push(`route:${mode}:${stops.length}`);
          return {
            status: "resolved",
            path: [
              [13.4, 52.5],
              [13.05, 52.39],
            ],
            distance: 34000,
            duration: 2400,
          } as const;
        }),
    }),
    Layer.succeed(ImageFetcher, {
      fetch: (imageUrl) =>
        Effect.suspend(() => {
          imageFetches.push(imageUrl);
          return imageUrl.includes("broken")
            ? Effect.fail(new ImageFetchFailed({ url: imageUrl, message: "HTTP 404" }))
            : Effect.succeed({
                bytes: Uint8Array.from(generatedPng),
                mediaType: "image/png",
                size: { width: 640, height: 480 },
              });
        }),
    }),
    ImageBlobStore,
    Layer.succeed(CustomToolRuntime, {
      inspect: () => Effect.die("no custom tool builds in these tests"),
      run: (input) =>
        customToolRun ? customToolRun(input) : Effect.die("no custom tool calls in these tests"),
    }),
  );
  // No background sweep: tests that assert queue state would otherwise race a
  // start nobody asked for. Settled hooks and explicit dispatch still run.
  const AppLayer = engineLayer(url, { gateway, services }).pipe(
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
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
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
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: false,
            vision: true,
            files: false,
          },
        },
        {
          id: textModelId,
          providerId,
          modelKey: "text",
          displayName: "Text Only",
          type: "chat",
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: false,
            vision: false,
            files: false,
          },
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
  yield* db.execute(
    `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
  );
  yield* db.execute(
    `insert into session (id, user_id, token, expires_at) values ('${userId}', '${userId}', '${uuidv7()}', now() + interval '1 day')` as never,
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

/** The same seed as a chat with a computer, bound to a machine of its owner. */
const setupComputerConversation = <A extends { conversation: { id: string } }, E, R>(
  setup: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const seed = yield* setup;
    const db = yield* Db;
    yield* db
      .update(conversations)
      .set({ machineId: "machine-1" })
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
    family: "ask",
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
  resolve: plainResolve,
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
  resolve: plainResolve,
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

  it("writes a text file and delivers it as the answer's attachment", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) {
        expect(Object.keys(input.toolkit?.tools ?? {})).toContain("create_file");
        return authoringTool(input, "create_file", {
          name: "totals.csv",
          content: "region,total\nnorth,12\n",
        });
      }
      if (round === 2)
        return authoringTool(input, "create_file", { name: "deck.pptx", content: "x" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Here it is." }),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId, conversationId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Give me the totals as a CSV.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const delivered = detail.attachments.filter((row) => row.messageId === assistantMessageId);
      expect(delivered.map((row) => row.fileName)).toEqual(["totals.csv"]);
      const calls = detail.toolCalls.filter((row) => row.toolName === "create_file");
      expect(calls.map((row) => row.status)).toEqual(["complete", "error"]);
      expect(calls[0]?.result).toMatchObject({ ok: true, attachmentId: delivered[0]!.id });
      // Each row keeps what was asked; only the failed call's full copy is kept aside.
      const stored = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({
              id: messageToolCalls.id,
              status: messageToolCalls.status,
              args: messageToolCalls.arguments,
              debug: toolCallDebugArguments.arguments,
            })
            .from(messageToolCalls)
            .leftJoin(
              toolCallDebugArguments,
              eq(toolCallDebugArguments.toolCallId, messageToolCalls.id),
            )
            .where(
              and(
                eq(messageToolCalls.messageId, assistantMessageId),
                eq(messageToolCalls.toolName, "create_file"),
              ),
            )
            .orderBy(messageToolCalls.callIndex),
        ),
      );
      expect(stored.map(({ args, debug }) => ({ args, debug }))).toEqual([
        { args: { name: "totals.csv", content: "region,total\nnorth,12\n" }, debug: null },
        {
          args: { name: "deck.pptx", content: "x" },
          debug: { name: "deck.pptx", content: "x" },
        },
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("inlines a long file's ends and lets the model read or search the rest", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const body = Array.from({ length: 12_000 }, (_, i) => `row ${i}, value ${i * 7}`).join("\n");
    const file = await runtime.runPromise(uploadText(seed.userId, "big.csv", body));
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "read_attachment", {
          attachmentId: file.id,
          pattern: "row 9876,",
        });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Found it." }),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId, conversationId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "What is row 9876?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [file.id],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      const first = JSON.stringify(prompts[0]!.prompt);
      expect(first).toContain("characters omitted");
      expect(first).not.toContain("row 9876,");
      expect(Object.keys(prompts[0]!.toolkit!.tools)).toContain("read_attachment");
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("row 9876, value 69132");
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const read = detail.toolCalls.find((call) => call.toolName === "read_attachment");
      expect(read?.result).toMatchObject({
        ok: true,
        fileName: "big.csv",
        mode: "search",
        matches: 1,
      });
      expect(JSON.stringify(read?.result)).not.toContain("69132");

      // In a branch the file is a copy with a new id; the original id, as a
      // summary's file list keeps it, still reads that copy.
      const branch = await runtime.runPromise(
        ChatService.use((service) =>
          service.branchConversation({
            userId: seed.userId,
            conversationId,
            messageId: assistantMessageId,
          }),
        ),
      );
      prompts.length = 0;
      const again = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: branch.conversationId },
            modelId: textModelId,
            content: "And row 9876 again?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(again.assistantMessageId);
      const branched = await runtime.runPromise(
        loadConversationDetail(seed.userId, branch.conversationId),
      );
      const reread = branched.toolCalls.find(
        (call) =>
          call.messageId === again.assistantMessageId && call.toolName === "read_attachment",
      );
      expect(reread?.result).toMatchObject({ ok: true, fileName: "big.csv", matches: 1 });
    } finally {
      authoringScript = null;
    }
  });

  it("reads a project's files like a chat's: a long text by range, an image by sight", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const projectId = uuidv7();
    // Past the 60k characters the old project reader cut at, with no line breaks.
    const body = Array.from(
      { length: 12_000 },
      (_, i) => `row ${String(i).padStart(5, "0")} `,
    ).join("");
    const { plan, logo } = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.insert(projects).values({ id: projectId, userId: seed.userId, name: "Launch" });
        yield* db
          .update(conversations)
          .set({ projectId })
          .where(eq(conversations.id, seed.conversation.id));
        const files = yield* ProjectFileService;
        const writer = { origin: "user", userId: seed.userId } as const;
        return {
          plan: yield* files.write(writer, {
            projectId,
            name: "plan.txt",
            bytes: new TextEncoder().encode(body),
          }),
          logo: yield* files.write(writer, {
            projectId,
            name: "logo.png",
            bytes: Uint8Array.from(generatedPng),
          }),
        };
      }),
    );
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "read_attachment", {
          attachmentId: `project:${plan.id}@${plan.version}`,
          offset: 100_000,
          length: 50,
        });
      if (prompts.length === 2)
        return authoringTool(input, "read_attachment", { attachmentId: "logo.png" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Read both." }),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId, conversationId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: visionModelId,
            content: "How does the plan end, and what is on the logo?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      expect(prompts).toHaveLength(3);
      // Offered with no chat file at all: the project's files are the reader's too.
      const offered = Object.keys(prompts[0]!.toolkit!.tools);
      expect(offered).toContain("read_attachment");
      expect(offered).not.toContain("read_project_file");
      expect(JSON.stringify(prompts[1]!.prompt)).toContain(body.slice(100_000, 100_050));
      const shown = prompts[2]!.prompt.content.flatMap((message) =>
        message.role === "user" ? message.content : [],
      );
      expect(shown).toContainEqual(
        expect.objectContaining({ type: "file", mediaType: "image/png", fileName: logo.name }),
      );
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const reads = detail.toolCalls.filter((call) => call.toolName === "read_attachment");
      expect(reads.map((call) => call.result)).toEqual([
        {
          ok: true,
          fileName: "plan.txt",
          mode: "range",
          from: 100_000,
          to: 100_050,
          total: body.length,
        },
        { ok: true, fileName: "logo.png" },
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("tells the next answer how the reader left an earlier answer's blocks, after history", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const block = "<script>let answers = $state([]);</script><quiz answers={answers}/>";
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", {
          id: "t",
          delta:
            prompts.length === 1 ? `Here:\n\n\`\`\`ui\n${block}\n\`\`\`\n` : "You picked Porto.",
        }),
        authoringFinish(),
      );
    };
    const send = (content: string) =>
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
    try {
      const quiz = await send("Quiz me on capitals");
      await collectDraftTurn(quiz.assistantMessageId);
      const saved = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const row = (yield* repo.listMessages(seed.conversation.id)).find(
            (message) => message.id === quiz.assistantMessageId,
          );
          return yield* repo.saveUiState({
            userId: seed.userId,
            messageId: row!.id,
            generationId: row!.generationId ?? null,
            ordinal: 0,
            sourceHash: hashSource(block),
            state: { answers: ["Porto"], __seed: 3 },
            digest: "Capitals: 1 of 3 answered, 0 right",
          });
        }),
      );
      expect(saved).toBe("saved");
      const next = await send("Which did I pick?");
      await collectDraftTurn(next.assistantMessageId);
      const prompt = JSON.stringify(prompts[1]!.prompt);
      const line = String.raw`Block 1 of your answer to \"Quiz me on capitals\": shows: Capitals: 1 of 3 answered, 0 right | $state: {\"answers\":[\"Porto\"]}`;
      expect(prompt).toContain(line);
      // After the earlier answer and the new question, so history stays cacheable.
      expect(prompt.indexOf(line)).toBeGreaterThan(prompt.indexOf("Which did I pick?"));
      expect(prompt).not.toContain("__seed");
    } finally {
      authoringScript = null;
    }
  });

  it("lets a block draw the route map_route found, asking the services once", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const block = `<map label="Trip"><pin place="Bernau"/><route mode="bike" stops={["Bernau", "Leipzig"]}/></map>`;
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "map_route", { stops: ["Bernau", "Leipzig"], mode: "bike" });
      return Stream.make(
        AiResponse.makePart("text-delta", {
          id: "t",
          delta: `34 km by bike:\n\n\`\`\`ui\n${block}\n\`\`\`\n`,
        }),
        authoringFinish(),
      );
    };
    const before = mapLookupCalls.length;
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "How far is Leipzig by bike?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      // The model got the real numbers back to write its prose from.
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("34000");
      // The block's pin and route came from the tool: nothing asked twice.
      expect(mapLookupCalls.slice(before).toSorted()).toEqual([
        "place:Bernau",
        "place:Leipzig",
        "route:bike:2",
      ]);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      const answer = detail.messages.find((message) => message.id === assistantMessageId)!;
      const key = routeKey({ mode: "bike", stops: ["Bernau", "Leipzig"] });
      expect(answer.assistantOutput?.routes?.[key]).toMatchObject({ distance: 34000 });
      expect(answer.assistantOutput?.places?.Bernau).toMatchObject({ status: "resolved" });
      // The row keeps the summary for the activity line and reloads with it.
      const call = detail.toolCalls.find((row) => row.toolName === "map_route");
      expect(call).toMatchObject({ status: "complete" });
      expect(call?.result).toMatchObject({ outcome: "routed", distance: 34000, mode: "bike" });
    } finally {
      authoringScript = null;
    }
  });

  it("adds the page's map lookups to a finished answer only for its owner and attempt", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const block = `<script>let stops = $state(["Innsbruck", "Salzburg"]);</script><map label="Trip">{#each stops as s}<pin place={s}/>{/each}</map>`;
    authoringScript = () =>
      Stream.make(
        AiResponse.makePart("text-delta", {
          id: "t",
          delta: `Trip:\n\n\`\`\`ui\n${block}\n\`\`\`\n`,
        }),
        authoringFinish(),
      );
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Plan a trip",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const row = (yield* repo.listMessages(seed.conversation.id)).find(
            (message) => message.id === assistantMessageId,
          );
          const own = {
            userId: seed.userId,
            messageId: assistantMessageId,
            generationId: row!.generationId ?? null,
          };
          const target = yield* repo.uiBlockForLookups({ ...own, ordinal: 0 });
          const stranger = yield* repo.uiBlockForLookups({
            ...own,
            userId: "someone-else",
            ordinal: 0,
          });
          const stale = yield* repo.uiBlockForLookups({ ...own, generationId: "old", ordinal: 0 });
          const missing = yield* repo.uiBlockForLookups({ ...own, ordinal: 1 });
          const first = yield* repo.recordPageLookups({
            ...own,
            places: { Innsbruck: { status: "resolved", lat: 47.27, lng: 11.39 } },
            routes: {},
          });
          // A second tab asking at once stores nothing over the first result.
          const second = yield* repo.recordPageLookups({
            ...own,
            places: {
              Innsbruck: { status: "unavailable" },
              Salzburg: { status: "resolved", lat: 47.81, lng: 13.06 },
            },
            routes: {},
          });
          const refused = yield* repo.recordPageLookups({
            ...own,
            generationId: "old",
            places: { Vienna: { status: "unavailable" } },
            routes: {},
          });
          return { target, stranger, stale, missing, first, second, refused };
        }),
      );
      expect(outcome.target).toEqual({
        code: block,
        lookups: { images: {}, places: {}, routes: {} },
      });
      expect(outcome.stranger).toBeNull();
      expect(outcome.stale).toBeNull();
      expect(outcome.missing).toBeNull();
      expect(outcome.first?.places).toEqual({
        Innsbruck: { status: "resolved", lat: 47.27, lng: 11.39 },
      });
      expect(outcome.second?.places).toEqual({
        Innsbruck: { status: "resolved", lat: 47.27, lng: 11.39 },
        Salzburg: { status: "resolved", lat: 47.81, lng: 13.06 },
      });
      expect(outcome.refused).toBeNull();
      // Stored with the answer, so a reload reads them without asking again.
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(JSON.stringify(detail)).toContain("Salzburg");
    } finally {
      authoringScript = null;
    }
  });

  it("opens each request of an answer with the whole previous one, its tail included", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "draft_agent", { changes: { name: "Helper" } });
      if (prompts.length === 2)
        return authoringTool(input, "draft_agent", { changes: { name: "Second" } });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Make me two agents.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collectDraftTurn(assistantMessageId);
      expect(prompts).toHaveLength(3);
      const serialized = (input: GatewayInput) =>
        input.prompt.content.map((message) =>
          JSON.stringify({ role: message.role, content: message.content }),
        );
      const [first, second, third] = prompts.map(serialized);
      // A provider that caches at the end of a request reads all of it next time.
      expect(second!.slice(0, first!.length)).toEqual(first);
      expect(third!.slice(0, second!.length)).toEqual(second);
      // The draft the first round created arrives after that round, and stays there.
      const round = second!.findIndex((message) => message.includes('"role":"tool"'));
      const draft = second!.findLastIndex((message) => message.includes('\\"name\\":\\"Helper\\"'));
      expect(round).toBeGreaterThan(-1);
      expect(draft).toBeGreaterThan(round);
      // Only what changed comes after the second round: the new draft, not Helper again.
      const added = third!.slice(second!.length);
      expect(added.some((message) => message.includes('\\"name\\":\\"Second\\"'))).toBe(true);
      // At most four cache points: the completed round, and the request's end,
      // which the next request extends.
      const anchors = prompts[1]!.prompt.content.flatMap((message, index) =>
        (message.options["cache"] as { anchor?: boolean } | undefined)?.anchor ? [index] : [],
      );
      expect(anchors.length).toBeLessThanOrEqual(4);
      expect(anchors).toContain(round);
      expect(anchors.at(-1)).toBe(prompts[1]!.prompt.content.length - 1);
    } finally {
      authoringScript = null;
    }
  });

  it("opens a turn with the previous answer's whole first request, then keeps or drops it", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      // The first answer calls a tool once, so its first request is not its last.
      if (prompts.length === 1)
        return authoringTool(input, "draft_agent", { changes: { name: "Helper" } });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    const send = (content: string) =>
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
    try {
      const first = await send("Make me an agent.");
      await collectDraftTurn(first.assistantMessageId);
      const second = await send("Thanks.");
      await collectDraftTurn(second.assistantMessageId);
      const third = await send("And now?");
      await collectDraftTurn(third.assistantMessageId);
      expect(prompts).toHaveLength(4);
      const serialized = (input: GatewayInput) =>
        input.prompt.content.map((message) =>
          JSON.stringify({ role: message.role, content: message.content }),
        );
      const [opened, , answered, again] = prompts.map(serialized);
      // A cache written at the end of an answer's first request is read by the next turn.
      expect(answered!.slice(0, opened!.length)).toEqual(opened);
      expect(again!.slice(0, answered!.length)).toEqual(answered);
      // Only what changed comes again: the draft and the policies are not repeated.
      const added = again!.slice(answered!.length);
      expect(added.some((message) => message.includes("<runtime-context>"))).toBe(true);
      expect(added.some((message) => message.includes('\\"name\\":\\"Helper\\"'))).toBe(false);

      const rows = () =>
        runtime.runPromise(
          Effect.flatMap(ChatRepo, (repo) => repo.listMessages(seed.conversation.id)),
        );
      expect(
        (await rows()).find((row) => row.id === third.assistantMessageId)?.opening,
      ).toMatchObject({ v: 1 });
      // A branch is a new conversation with a cache of its own: no opening comes along.
      const branch = await runtime.runPromise(
        ChatService.use((service) =>
          service.branchConversation({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: third.assistantMessageId,
          }),
        ),
      );
      const copied = await runtime.runPromise(
        ChatRepo.use((repo) => repo.listMessages(branch.conversationId)),
      );
      expect(copied.every((row) => row.opening == null)).toBe(true);
      // A retry is a new first request, so it keeps the opening it sent, not the old one.
      const before = (await rows()).find((row) => row.id === third.assistantMessageId)?.opening;
      await runtime.runPromise(
        ChatService.use((service) =>
          service.retryMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: third.assistantMessageId,
          }),
        ),
      );
      await collectDraftTurn(third.assistantMessageId);
      const after = (await rows()).find((row) => row.id === third.assistantMessageId)?.opening;
      expect(after).toMatchObject({ v: 1 });
      expect(after).not.toEqual(before);
    } finally {
      authoringScript = null;
    }
  });

  it.each([false, true])(
    "offers drafting tools on request and keeps them for the chat (Hermes: %s)",
    async (hermes) => {
      const seed = await runtime.runPromise(ordinaryChat);
      const advertised = (input: GatewayInput) =>
        typeof input.toolChoice === "object"
          ? [...input.toolChoice.oneOf]
          : Object.keys(input.toolkit?.tools ?? {});
      const prompts: GatewayInput[] = [];
      authoringScript = (input) => {
        prompts.push(input);
        // Unadvertised, yet called: the call runs and loads its family.
        if (prompts.length === 1)
          return authoringTool(input, "draft_agent", { changes: { name: "Helper" } }, hermes);
        if (prompts.length === 3)
          return authoringTool(input, "load_tools", { families: ["schedule-draft"] }, hermes);
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
          authoringFinish(),
        );
      };
      const send = (content: string) =>
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
      try {
        await collectDraftTurn((await send("Make me an agent.")).assistantMessageId);
        expect(advertised(prompts[0]!)).toContain("load_tools");
        expect(advertised(prompts[0]!)).not.toContain("draft_agent");
        expect(Object.keys(prompts[0]!.toolkit!.tools)).toContain("draft_agent");
        expect(JSON.stringify(prompts[0]!.prompt)).toContain("- agent-draft:");
        expect(advertised(prompts[1]!)).toContain("draft_agent");
        expect(advertised(prompts[1]!)).not.toContain("draft_schedule");

        // A later turn keeps what this chat used, and load_tools adds more.
        await collectDraftTurn((await send("Also schedule it.")).assistantMessageId);
        expect(advertised(prompts[2]!)).toContain("draft_agent");
        expect(advertised(prompts[2]!)).not.toContain("draft_schedule");
        expect(advertised(prompts[3]!)).toContain("draft_schedule");
        // The catalogue never changes as families load, so it stays cached.
        const catalogue = (input: GatewayInput) =>
          JSON.stringify(input.prompt).match(/More tools are available[^"]*/)?.[0];
        expect(catalogue(prompts[3]!)).toBe(catalogue(prompts[0]!));

        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, seed.conversation.id),
        );
        const load = detail.toolCalls.find((call) => call.toolName === "load_tools");
        expect(load?.result).toEqual({ loaded: ["schedule-draft"], unavailable: [] });
        expect(load?.status).toBe("complete");
      } finally {
        authoringScript = null;
      }
    },
  );
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
        expect(detail.agentDrafts.map((loaded) => loaded.id)).toEqual([draft!.id]);
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
      const answers: string[] = [];
      for (const content of ["Set up a morning digest.", "Weekdays only.", "Thanks."]) {
        const sent = await turn(content);
        await collectDraftTurn(sent.assistantMessageId);
        answers.push(sent.assistantMessageId);
      }
      // A builtin is in no pinned selection, yet the live row names it from its start.
      const starts = (
        await runtime.runPromise(ChatRepo.use((repo) => repo.chunksAfter(answers[0]!, 0)))
      )
        .filter((chunk) => chunk.kind === "tool")
        .map((chunk) => JSON.parse(chunk.delta) as Record<string, unknown>)
        .filter((envelope) => envelope.family === "skill" && envelope.phase === "start");
      expect(starts).toEqual([
        expect.objectContaining({
          skillId: SCHEDULE_AUTHORING_SKILL.id,
          skillName: SCHEDULE_AUTHORING_SKILL.name,
        }),
      ]);
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
      // Cache anchors move on from turn to turn; what is sent does not.
      const bytes = (input: GatewayInput) =>
        content(input)
          .slice(0, answerAt + 1)
          .map(({ role, content: sent }) => JSON.stringify({ role, sent }));
      expect(bytes(latest!)).toEqual(bytes(later!));
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
      expect(detail.agentDrafts.map((draft) => draft.name).toSorted()).toEqual([
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
    // The id comes from the latest draft data in the prompt, which is how a
    // real model learns it: earlier snapshots stay where they were sent.
    const idOf = (input: GatewayInput, name: string) => {
      const block = input.prompt.content
        .flatMap((message) => {
          const content: unknown = message.content;
          return typeof content === "string"
            ? [content]
            : (content as Array<{ text?: string }>).map((part) => part.text ?? "");
        })
        .findLast((text) => text.startsWith("Application-provided agent draft"));
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
      // Four tool rounds, then the answer.
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
          ...(openDocumentId ? { openDocument: { id: openDocumentId } } : {}),
        }),
      ),
    );
  /** A chat's documents, each with its tree as Markdown, made on demand. */
  const documentsOf = (seed: Effect.Success<typeof ordinaryChat>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* DocumentService;
        const listed = yield* service.list(seed.userId, { conversationId: seed.conversation.id });
        return yield* Effect.forEach(listed, (document) =>
          service
            .read(seed.userId, document.id)
            .pipe(Effect.map((read) => ({ ...document, content: toMarkdown(read!.doc) }))),
        );
      }),
    );
  // The tool-role messages of a prompt: what the continuation transcript feeds
  // back, as opposed to the trailing data, which carries the document on purpose.
  const toolMessages = (input: GatewayInput) =>
    JSON.stringify(input.prompt.content.filter((message) => message.role === "tool"));
  /** Every document view the request carried, in order, as the model reads it. */
  const documentText = (input: GatewayInput) =>
    [...input.prompt.content]
      .filter(
        (candidate) =>
          candidate.role === "assistant" &&
          JSON.stringify(candidate.content).includes("Application-provided document"),
      )
      .map((message) =>
        (message.content as ReadonlyArray<{ text?: string }>)
          .map((part) => part.text ?? "")
          .join(""),
      )
      .join("\n");
  const attributes = (tag: string) =>
    Object.fromEntries(
      [...tag.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
    );
  /** The focused document's latest header and the others' summaries, from the XML. */
  const trailing = (input: GatewayInput) => {
    const text = documentText(input);
    if (!text) return null;
    const headers = [...text.matchAll(/<document ([^>]*?)\/?>/g)].map((match) =>
      attributes(match[1]!),
    );
    const focused = headers.filter((header) => header.focused === "true").at(-1);
    const lastBlock = text.slice(text.lastIndexOf("<documents>"));
    const others = [...lastBlock.matchAll(/<document ([^>]*?)\/>/g)].map((match) => {
      const header = attributes(match[1]!);
      return { id: header.id, title: header.title };
    });
    return {
      text,
      focused: focused
        ? {
            id: focused.id,
            title: focused.title,
            revision: Number(focused.revision),
            lastEditedBy: focused.lastEditedBy,
            editedSinceYourLastWrite: focused.editedSinceYourLastWrite === "true",
          }
        : null,
      others,
    };
  };
  /** The id the request showed for the block holding `text`, as a model would read it. */
  const blockIdIn = (input: GatewayInput, text: string) => {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`id="([a-z0-9]+)"[^>]*>${escaped}<`).exec(documentText(input));
    if (!match) throw new Error(`no block holding ${text} in the request`);
    return match[1]!;
  };

  it("offers no more tools once one fails the same way three times in a row", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const requests: GatewayInput[] = [];
    authoringScript = (input) => {
      requests.push(input);
      // No title: refused with the same correction every time.
      return input.toolkit
        ? authoringTool(input, "create_document", { content: "- [ ] ship" })
        : reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      expect(requests.map((request) => request.toolkit !== undefined)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(JSON.stringify(requests[3]!.prompt.content)).toContain(
        "create_document failed the same way 3 times in a row",
      );
      expect(JSON.stringify(requests[2]!.prompt.content)).not.toContain("failed the same way");
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => call.status)).toEqual(["error", "error", "error"]);
      expect(detail.messages.at(-1)).toMatchObject({ status: "complete" });
    } finally {
      authoringScript = null;
    }
  });

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
            { target: blockIdIn(input, "ship"), position: "after", content: "- [ ] announce" },
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
          focused: { title: "Release checklist" },
          others: [],
        });
        expect(trailing(prompts[1]!)!.text).toContain(">write notes</task>");
        expect(trailing(prompts[2]!)!.focused).toMatchObject({
          lastEditedBy: "model",
          editedSinceYourLastWrite: false,
        });
        expect(trailing(prompts[2]!)!.focused!.revision).toBeGreaterThan(0);
        expect(trailing(prompts[2]!)!.text).toContain(">announce</task>");
        // The continuation carries pointers, never the document.
        expect(toolMessages(prompts[2]!)).toContain("trailing application data");
        expect(toolMessages(prompts[2]!)).not.toContain("write notes");
        expect(toolMessages(prompts[2]!)).not.toContain("announce");
        const [document] = await documentsOf(seed);
        expect(document).toMatchObject({
          title: "Release checklist",
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
            // A streamed creation writes its content after the document exists.
            revision: expect.any(Number),
          },
          {
            outcome: "updated",
            documentId: document!.id,
            documentConversationId: seed.conversation.id,
            title: "Release checklist",
            // The revision its write landed at; a preview settled with nothing
            // left to write reports the one it already reached.
            revision: expect.any(Number),
          },
        ]);
        expect((detail.toolCalls[1]!.result as { revision: number }).revision).toBeLessThanOrEqual(
          document!.revision,
        );
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
            sessionId: seed.userId,
            revision: null,
            clientId: "watcher",
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
            streamedTool(
              input,
              "edit_document",
              {
                target: blockIdIn(input, "tag build"),
                content: "- [ ] tag the build and publish the release notes for everyone",
              },
              12,
              Duration.millis(40),
            ),
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
      // Written as it streamed, a piece at a time; settling writes only what is still missing.
      const updates = frames.filter((frame) => frame.type === "steps");
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

  it("pages through a long document by following each window's note to the end", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const sections = Array.from(
      { length: 120 },
      (_, index) => `## Section ${index + 1}\n\n${`Words of section ${index + 1}. `.repeat(20)}`,
    );
    const notes: string[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Long",
          content: sections.join("\n\n"),
        });
      // Later rounds follow the latest read's result. The first view keeps
      // its first note, so following notes in the views could repeat it.
      const results = JSON.stringify(input.prompt.content.filter((each) => each.role === "tool"));
      const note =
        [...results.matchAll(/call read_chat_document with (\{[^}]*\})/g)]
          .map((match) => match[1]!.replaceAll('\\"', '"'))
          .at(-1) ?? /Call read_chat_document with (\{[^}]*\})/.exec(documentText(input))?.[1];
      if (note && notes.length < 10 && notes.at(-1) !== note) {
        notes.push(note);
        return authoringTool(input, "read_chat_document", JSON.parse(note));
      }
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const last = documentText(prompts.at(-1)!);
      expect(notes.length).toBeGreaterThan(1);
      // The final request shows the end of the document, and the last read said so.
      expect(last).toContain("Section 120");
      const results = JSON.stringify(
        prompts.at(-1)!.prompt.content.filter((each) => each.role === "tool"),
      );
      expect(results).toContain("reaches the end of the document");
    } finally {
      authoringScript = null;
    }
  });

  it("appends to a long document's end and a section's end without reading there", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const sections = Array.from(
      { length: 120 },
      (_, index) => `## Section ${index + 1}\n\n${`Words of section ${index + 1}. `.repeat(20)}`,
    );
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Long",
          content: sections.join("\n\n"),
        });
      if (prompts.length === 2)
        return authoringTool(input, "edit_document", { target: "end", content: "Closing words." });
      if (prompts.length === 3) {
        // Section 60 lies beyond the first window; its heading is in the gap's outline.
        const heading = /<h2 id="([a-z0-9]+)">Section 60</.exec(documentText(input))?.[1];
        return authoringTool(input, "edit_document", {
          target: heading,
          position: "end",
          content: "Added to section 60.",
        });
      }
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content.endsWith("Closing words.")).toBe(true);
      // The request after each write shows what it wrote, far past the first window.
      expect(documentText(prompts[2]!)).toContain("Closing words.");
      expect(documentText(prompts[3]!)).toContain("Added to section 60.");
      expect(document!.content).toMatch(
        /Words of section 60\. ?\n\nAdded to section 60\.\n\n## Section 61/,
      );
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "created",
        "updated",
        "updated",
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("reports a conflict, not a second copy, when a person edits a streaming insert", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const gate = await runtime.runPromise(Deferred.make<void>());
    const text = "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Plan", content: CHECKLIST });
      if (prompts.length > 2) return reply();
      const params = { target: "end", content: text };
      const json = JSON.stringify(params);
      const cut = json.indexOf("delta");
      const id = uuidv7();
      const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
      return Stream.unwrap(
        LanguageModel.make({
          generateText: () => Effect.die("only streaming is used here"),
          streamText: () =>
            Stream.make(
              AiResponse.makePart("tool-params-start", {
                id,
                name: "edit_document",
                providerExecuted: false,
              }),
              AiResponse.makePart("tool-params-delta", { id, delta: json.slice(0, cut) }),
            ).pipe(
              // The provider pauses while the person types into what has landed.
              Stream.concat(Stream.fromEffectDrain(Deferred.await(gate))),
              Stream.concat(
                Stream.make(
                  AiResponse.makePart("tool-params-delta", { id, delta: json.slice(cut) }),
                  AiResponse.makePart("tool-params-end", { id }),
                  AiResponse.makePart("tool-call", {
                    id,
                    name: "edit_document",
                    params,
                    providerExecuted: false,
                  }),
                  authoringFinish("tool-calls"),
                ),
              ),
              Stream.mapEffect((part) => encodePart(part)),
              Stream.orDie,
            ),
        }).pipe(
          Effect.map((model) =>
            model.streamText({ prompt: input.prompt, toolkit: input.toolkit! }),
          ),
        ),
      ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
    };
    try {
      const sent = await send(seed);
      const [created] = await runtime.runPromise(
        Effect.gen(function* () {
          for (;;) {
            const found = yield* Effect.promise(() => documentsOf(seed));
            if (found[0]?.content.includes("Alpha bravo charlie")) return found;
            yield* Effect.sleep(Duration.millis(50));
          }
        }).pipe(Effect.timeout(Duration.seconds(10))),
      );
      const editor = await collabEditor(runtime.runPromise, seed.userId, created!.id);
      await editor!.type((markdown) => markdown.replace("Alpha bravo", "Alpha PERSON bravo"));
      await runtime.runPromise(Deferred.succeed(gate, undefined));
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content.split("Alpha")).toHaveLength(2);
      expect(document!.content).toContain("Alpha PERSON bravo");
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "created",
        "conflict",
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it.each([
    ["a scope sent after the content", { scope: "chat" }, null],
    ["no scope, which in a project means the project", {}, "project"],
  ] as const)(
    "streams a project chat's new document in private until the call says where (%s)",
    async (_label, extra, expected) => {
      const seed = await runtime.runPromise(ordinaryChat);
      const projectId = uuidv7();
      await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* db.insert(projects).values({ id: projectId, userId: seed.userId, name: "Launch" });
          yield* db
            .update(conversations)
            .set({ projectId })
            .where(eq(conversations.id, seed.conversation.id));
        }),
      );
      const gate = await runtime.runPromise(Deferred.make<void>());
      // The content first, any scope only after it, as a model may write them.
      const params = {
        title: "Notes",
        content: "Alpha bravo charlie delta echo foxtrot",
        ...extra,
      };
      let calls = 0;
      authoringScript = (input) => {
        calls++;
        if (calls > 1) return reply();
        const json = JSON.stringify(params);
        const cut = json.indexOf("delta");
        const id = uuidv7();
        const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
        return Stream.unwrap(
          LanguageModel.make({
            generateText: () => Effect.die("only streaming is used here"),
            streamText: () =>
              Stream.make(
                AiResponse.makePart("tool-params-start", {
                  id,
                  name: "create_document",
                  providerExecuted: false,
                }),
                AiResponse.makePart("tool-params-delta", { id, delta: json.slice(0, cut) }),
              ).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.await(gate))),
                Stream.concat(
                  Stream.make(
                    AiResponse.makePart("tool-params-delta", { id, delta: json.slice(cut) }),
                    AiResponse.makePart("tool-params-end", { id }),
                    AiResponse.makePart("tool-call", {
                      id,
                      name: "create_document",
                      params,
                      providerExecuted: false,
                    }),
                    authoringFinish("tool-calls"),
                  ),
                ),
                Stream.mapEffect((part) => encodePart(part)),
                Stream.orDie,
              ),
          }).pipe(
            Effect.map((model) =>
              model.streamText({ prompt: input.prompt, toolkit: input.toolkit! }),
            ),
          ),
        ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
      };
      // Every document of the chat or its project, private ones included, read from the tree.
      const stored = () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const db = yield* Db;
            const service = yield* DocumentService;
            const rows = yield* db
              .select({ id: documents.id, projectId: documents.projectId })
              .from(documents)
              .where(
                or(
                  eq(documents.conversationId, seed.conversation.id),
                  eq(documents.projectId, projectId),
                ),
              );
            return yield* Effect.forEach(rows, (row) =>
              service
                .read(seed.userId, row.id)
                .pipe(
                  Effect.map((read) => ({ ...row, content: read ? toMarkdown(read.doc) : "" })),
                ),
            );
          }),
        );
      try {
        const sent = await send(seed);
        const streaming = await runtime.runPromise(
          Effect.gen(function* () {
            for (;;) {
              const found = yield* Effect.promise(stored);
              if (found[0]?.content.includes("Alpha bravo")) return found;
              yield* Effect.sleep(Duration.millis(50));
            }
          }).pipe(Effect.timeout(Duration.seconds(10))),
        );
        // While it streams, it is the chat's alone.
        expect(streaming).toMatchObject([{ projectId: null }]);
        await runtime.runPromise(Deferred.succeed(gate, undefined));
        await settle(sent.assistantMessageId);
        const final = await stored();
        expect(final).toHaveLength(1);
        expect(final[0]!.id).toBe(streaming[0]!.id);
        expect(final[0]!.projectId).toBe(expected === "project" ? projectId : null);
        expect(final[0]!.content).toContain("foxtrot");
      } finally {
        authoringScript = null;
      }
    },
  );

  it("keeps what a person types into a document while its creation streams", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const gate = await runtime.runPromise(Deferred.make<void>());
    const params = {
      title: "Trip",
      content: "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima",
    };
    let calls = 0;
    authoringScript = (input) => {
      calls++;
      if (calls > 1) return reply();
      const json = JSON.stringify(params);
      const cut = json.indexOf("delta");
      const id = uuidv7();
      const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
      return Stream.unwrap(
        LanguageModel.make({
          generateText: () => Effect.die("only streaming is used here"),
          streamText: () =>
            Stream.make(
              AiResponse.makePart("tool-params-start", {
                id,
                name: "create_document",
                providerExecuted: false,
              }),
              AiResponse.makePart("tool-params-delta", { id, delta: json.slice(0, cut) }),
            ).pipe(
              Stream.concat(Stream.fromEffectDrain(Deferred.await(gate))),
              Stream.concat(
                Stream.make(
                  AiResponse.makePart("tool-params-delta", { id, delta: json.slice(cut) }),
                  AiResponse.makePart("tool-params-end", { id }),
                  AiResponse.makePart("tool-call", {
                    id,
                    name: "create_document",
                    params,
                    providerExecuted: false,
                  }),
                  authoringFinish("tool-calls"),
                ),
              ),
              Stream.mapEffect((part) => encodePart(part)),
              Stream.orDie,
            ),
        }).pipe(
          Effect.map((model) =>
            model.streamText({ prompt: input.prompt, toolkit: input.toolkit! }),
          ),
        ),
      ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
    };
    try {
      const sent = await send(seed);
      const [created] = await runtime.runPromise(
        Effect.gen(function* () {
          for (;;) {
            const found = yield* Effect.promise(() => documentsOf(seed));
            if (found[0]?.content.includes("Alpha bravo charlie")) return found;
            yield* Effect.sleep(Duration.millis(50));
          }
        }).pipe(Effect.timeout(Duration.seconds(10))),
      );
      const editor = await collabEditor(runtime.runPromise, seed.userId, created!.id);
      await editor!.type((markdown) => `${markdown}\n\nMy own note`);
      await runtime.runPromise(Deferred.succeed(gate, undefined));
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toContain("My own note");
      expect(document!.content).toContain("Alpha bravo charlie");
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "conflict",
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("deletes a block when a streamed edit replaces it with nothing", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Plan", content: CHECKLIST });
      if (prompts.length === 2)
        return streamedTool(
          input,
          "edit_document",
          { target: blockIdIn(input, "tag build"), content: "" },
          6,
          Duration.millis(20),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toBe(CHECKLIST.replace("- [ ] tag build\n", ""));
    } finally {
      authoringScript = null;
    }
  });

  it("keeps what a streamed edit wrote when the answer is stopped mid-write", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const text = "Launch day starts with a final check of every redirect. ".repeat(6).trim();
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Plan", content: CHECKLIST });
      // Half the arguments, then the provider goes quiet until the reader stops.
      const json = JSON.stringify({ target: "end", content: text });
      const id = uuidv7();
      const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
      return Stream.unwrap(
        LanguageModel.make({
          generateText: () => Effect.die("only streaming is used here"),
          streamText: () =>
            Stream.make(
              AiResponse.makePart("tool-params-start", {
                id,
                name: "edit_document",
                providerExecuted: false,
              }),
              AiResponse.makePart("tool-params-delta", { id, delta: json.slice(0, 40) }),
              AiResponse.makePart("tool-params-delta", { id, delta: json.slice(40, 200) }),
            ).pipe(
              Stream.concat(Stream.never),
              Stream.mapEffect((part) => encodePart(part)),
              Stream.orDie,
            ),
        }).pipe(
          Effect.map((model) =>
            model.streamText({ prompt: input.prompt, toolkit: input.toolkit! }),
          ),
        ),
      ).pipe(Stream.orDie) as Stream.Stream<ChatStreamPart>;
    };
    try {
      const sent = await send(seed);
      // Wait for the preview to have typed some of it out.
      await runtime.runPromise(
        Effect.gen(function* () {
          for (;;) {
            const [document] = yield* Effect.promise(() => documentsOf(seed));
            if (document && document.content.includes("final check")) return;
            yield* Effect.sleep(Duration.millis(50));
          }
        }).pipe(Effect.timeout(Duration.seconds(10))),
      );
      const stopped = await runtime.runPromise(
        Effect.gen(function* () {
          const message = yield* (yield* ChatRepo).getMessage(sent.assistantMessageId);
          return yield* (yield* StreamEngine).stopGeneration(
            sent.assistantMessageId,
            message?.generationId ?? undefined,
          );
        }),
      );
      expect(stopped).toBe(true);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toContain("Launch day starts with a final check");
    } finally {
      authoringScript = null;
    }
  });

  it("lands a streamed append at the end once, though the end moved as it streamed", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    // Longer than one window, as a thesis is.
    const long = Array.from(
      { length: 120 },
      (_, index) => `## Section ${index + 1}\n\n${`Words of section ${index + 1}.`.repeat(20)}`,
    );
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Plan",
          content: [CHECKLIST, ...long].join("\n\n"),
        });
      if (prompts.length === 2)
        return streamedTool(
          input,
          "edit_document",
          { target: "end", content: "## Closing\n\nOne closing paragraph, written once." },
          12,
          Duration.millis(30),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content.endsWith("## Closing\n\nOne closing paragraph, written once.")).toBe(
        true,
      );
      expect(document!.content.split("## Closing")).toHaveLength(2);
      // The request after the write shows it, so the model sees its work done.
      expect(documentText(prompts[2]!)).toContain("written once");
    } finally {
      authoringScript = null;
    }
  });

  it("types out text that arrives in large chunks a few words at a time", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const frames: DocumentFrame[] = [];
    let watcher: Fiber.Fiber<void> | null = null;
    const watch = Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* DocumentService;
          const [document] = yield* service.list(seed.userId, {
            conversationId: seed.conversation.id,
          });
          const feed = yield* service.subscribe(seed.userId, document!.id, {
            sessionId: seed.userId,
            revision: null,
            clientId: "watcher",
          });
          watcher = Effect.runFork(
            Stream.runForEach(feed!, (frame) => Effect.sync(() => frames.push(frame))),
          );
        }),
      ),
    );
    const paragraph = "The release goes out on Friday once the notes are reviewed. "
      .repeat(7)
      .trim();
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Plan", content: CHECKLIST });
      if (prompts.length === 2)
        return Stream.fromEffectDrain(watch).pipe(
          Stream.concat(
            // Two big chunks, as a provider that batches sends them.
            streamedTool(
              input,
              "edit_document",
              { target: blockIdIn(input, "Release"), position: "after", content: paragraph },
              2,
              Duration.millis(200),
            ),
          ),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      expect(document!.content).toContain(paragraph);
      const inserted = frames
        .flatMap((frame) => (frame.type === "steps" ? frame.steps : []))
        .map((step) => {
          const slice = (step as { slice?: { content?: unknown } }).slice;
          return JSON.stringify(slice?.content ?? "").length;
        });
      // Typed out over many writes, none carrying more than a short stretch of new text.
      expect(inserted.length).toBeGreaterThan(8);
      expect(inserted.filter((size) => size > 200)).toHaveLength(0);
      // Each paced write is stored as the generation's, like any other model write.
      const steps = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({ origin: documentSteps.origin, generationId: documentSteps.generationId })
            .from(documentSteps)
            .where(eq(documentSteps.documentId, document!.id)),
        ),
      );
      const model = steps.filter((step) => step.origin === "model");
      expect(model.length).toBeGreaterThan(8);
      expect(model.filter((step) => step.generationId === null)).toEqual([]);
    } finally {
      authoringScript = null;
      if (watcher) await Effect.runPromise(Fiber.interrupt(watcher));
    }
  });

  it("streams a list as its new words, never rewriting the items already there", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const frames: DocumentFrame[] = [];
    let watcher: Fiber.Fiber<void> | null = null;
    const watch = Effect.promise(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* DocumentService;
          const [document] = yield* service.list(seed.userId, {
            conversationId: seed.conversation.id,
          });
          const feed = yield* service.subscribe(seed.userId, document!.id, {
            sessionId: seed.userId,
            revision: null,
            clientId: "watcher",
          });
          watcher = Effect.runFork(
            Stream.runForEach(feed!, (frame) => Effect.sync(() => frames.push(frame))),
          );
        }),
      ),
    );
    const list = Array.from(
      { length: 6 },
      (_, index) => `- step ${index + 1}: check the release notes and the build once more`,
    ).join("\n");
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Steps", content: CHECKLIST });
      if (prompts.length === 2)
        return Stream.fromEffectDrain(watch).pipe(
          Stream.concat(
            streamedTool(
              input,
              "edit_document",
              { target: blockIdIn(input, "Release"), position: "after", content: list },
              30,
              Duration.millis(40),
            ),
          ),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const replaced = frames
        .flatMap((frame) => (frame.type === "steps" ? frame.steps : []))
        .map((step) => {
          const { from, to } = step as { from?: number; to?: number };
          return from === undefined || to === undefined ? 0 : to - from;
        });
      expect(replaced.length).toBeGreaterThan(5);
      // A tick replaces at most the end of the item being written; the list
      // itself, a few hundred positions by the end, is never written again.
      expect(Math.max(...replaced)).toBeLessThan(80);
    } finally {
      authoringScript = null;
      if (watcher) await Effect.runPromise(Fiber.interrupt(watcher));
    }
  });

  it("keeps a streamed table its own through every tick and settles it", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    const table = "| Layer | Tool |\n| --- | --- |\n| Web | Next.js |\n| CMS | Payload |";
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", { title: "Stack", content: CHECKLIST });
      if (prompts.length === 2)
        // Paced so ticks land mid-row, when the last row is still short.
        return streamedTool(
          input,
          "edit_document",
          { target: blockIdIn(input, "Release"), position: "after", content: table },
          24,
          Duration.millis(40),
        );
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      const [document] = await documentsOf(seed);
      // Columns come back padded to their widest cell.
      expect(document!.content.replace(/ +/g, " ").replace(/-{3,}/g, "---")).toBe(
        CHECKLIST.replace(
          "# Release",
          "# Release\n\n| Layer | Tool |\n| --- | --- |\n| Web | Next.js |\n| CMS | Payload |",
        ),
      );
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "created",
        "updated",
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("never ends the request after a new document on its assistant-role data", async () => {
    const seed = await runtime.runPromise(ordinaryChat);
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      if (prompts.length === 1)
        return authoringTool(input, "create_document", {
          title: "Release checklist",
          content: CHECKLIST,
        });
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      expect(prompts).toHaveLength(2);
      // The document's data is an assistant message; ending on it is a prefill,
      // which models without prefill support reject with a 400.
      const roles = prompts[1]!.prompt.content.map((message) => message.role);
      expect(roles.at(-1)).not.toBe("assistant");
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("Application-provided documents");
    } finally {
      authoringScript = null;
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
        // A position that does not exist: the preview streams, the call is refused.
        return streamedTool(input, "edit_document", {
          target: blockIdIn(input, "tag build"),
          content: "- [ ] tag a completely different build instead",
          position: "instead",
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

  it("shows a person's edit between rounds, flagged until the model has been sent it", async () => {
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
          // The panel's tick, typed in an editor opened from the live feed.
          const editor = yield* Effect.promise(() =>
            collabEditor(runtime.runPromise, seed.userId, document!.id),
          );
          // Ticks the first task, which in the tree is its checked attribute.
          return yield* Effect.promise(() =>
            editor!.type((markdown) => markdown.replace("[ ]", "[x]")),
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
        return authoringTool(input, "edit_document", {
          target: blockIdIn(input, "tag build"),
          position: "after",
          content: "- [ ] run tests",
        }).pipe(Stream.concat(Stream.fromEffectDrain(personTicks)));
      if (prompts.length === 3)
        // Aimed at the task the person ticked, which this request has shown it.
        return authoringTool(input, "edit_document", {
          target: blockIdIn(input, "write notes"),
          content: "- [ ] write release notes",
        });
      return reply();
    };
    try {
      const sent = await send(seed);
      await settle(sent.assistantMessageId);
      expect(prompts).toHaveLength(4);
      const [document] = await documentsOf(seed);
      expect(trailing(prompts[2]!)!.focused).toMatchObject({
        lastEditedBy: "user",
        editedSinceYourLastWrite: true,
      });
      expect(trailing(prompts[2]!)!.text).toContain('checked="true">write notes</task>');
      expect(trailing(prompts[2]!)!.text).toContain(">run tests</task>");
      // Having been sent the person's change and written after it, the flag clears.
      expect(trailing(prompts[3]!)!.focused).toMatchObject({
        revision: document!.revision,
        lastEditedBy: "model",
        editedSinceYourLastWrite: false,
      });
      expect(document!.content).toBe(
        "# Release\n\n- [ ] write release notes\n- [ ] tag build\n- [ ] run tests\n- [ ] ship",
      );
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, seed.conversation.id),
      );
      expect(detail.toolCalls.map((call) => (call.result as { outcome: string }).outcome)).toEqual([
        "created",
        "updated",
        "updated",
      ]);
      // The document reached the model only as trailing data, never in a tool result.
      expect(JSON.stringify(detail)).not.toContain("write notes");
      expect(toolMessages(prompts[3]!)).not.toContain("write notes");
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
          Stream.concat(authoringTool(input, "edit_document", { find: "ship", content: "STALE" })),
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
        focused: { id: first.document.id },
        others: [{ id: second.document.id, title: "Second" }],
      });
      expect(trailing(prompts[0]!)!.text).toContain(">one</p>");
      expect(trailing(prompts[0]!)!.text).not.toContain(">two<");
    } finally {
      authoringScript = null;
    }
  });
});

describe("structured answer persistence and edits", () => {
  it("edits answers by regenerating their answer", async () => {
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
        const originalCalls = yield* repo.listToolCalls([seed.assistant.id]);
        const input = {
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: turn.userMessage.id,
          modelId: textModelId,
          attachmentIds: [],
        };
        const ordinary = yield* service
          .editMessage({
            ...input,
            content: "unrelated text",
            searchEnabled: false,
            researchEnabled: false,
          })
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
      questionResponse: { v: 1, callId: result.originalCalls[0]!.id, response: result.response },
    });
    expect(result.afterCalls).toEqual(result.originalCalls);
    expect(result.branchMessages[2]).toMatchObject({
      content: result.answer!.content,
      // The copy names the branch's own copy of the question.
      questionResponse: {
        v: 1,
        callId: result.calls[0]!.id,
        response: result.response,
      },
    });
    expect(result.calls[0]).toMatchObject({ textOffset: 0 });
    expect(result.calls[0]!.id).not.toBe(result.originalCalls[0]!.id);
    expect(result.chunks).toEqual([]);
  });

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
          resolve: plainResolve,
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
          resolve: plainResolve,
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
                    resolve: plainResolve,
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

  it("refuses to edit a question that has no answer to regenerate", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const { userId, conversation } = yield* setupConversation;
        const question = yield* repo.insertMessage({
          conversationId: conversation.id,
          role: "user",
          content: "left without an answer",
        });
        const failure = yield* chat
          .editMessage({
            userId,
            conversationId: conversation.id,
            messageId: question.id,
            modelId: textModelId,
            content: "edited",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          })
          .pipe(Effect.flip);
        return { failure, question: yield* repo.getMessage(question.id) };
      }),
    );
    expect(result.failure).toMatchObject({ _tag: "EditNotAllowed" });
    expect(english((result.failure as { reason: Localized }).reason)).toBe(
      "this message has no answer to regenerate",
    );
    expect(result.question?.content).toBe("left without an answer");
  });

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
        return { rewind, messages: yield* repo.listMessages(seed.conversation.id) };
      }),
    );
    expect(result.rewind.claimed).toBe(false);
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
    // The branch's answer names the branch's own copy of the question.
    expect(result.branchTurn.userMessage.questionResponse).toEqual({
      v: 1,
      callId: result.calls[0]!.id,
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
          })
          .pipe(Effect.flip);
        const before = yield* repo.listMessages(seed.conversation.id);
        const reply = yield* service.sendMessage({
          ...answerInput(seed),
          modelId: visionModelId,
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
    yield* db.execute(
      `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
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

describe("turn acceptance", () => {
  it("rolls back first-turn integration choices and files when any integration is missing", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* seedAnswered(textModelId);
        const integrationId = uuidv7();
        yield* db
          .insert(integrationConfigs)
          .values({ id: integrationId, kind: "outline", name: integrationId });
        // Choices name the person's accounts; one of theirs, and one that does not exist.
        const connectionId = uuidv7();
        yield* db.insert(integrationConnections).values({
          id: connectionId,
          userId: seed.userId,
          integrationId,
          authKind: "none",
          credentialsCiphertext: "unused",
          accountLabel: "Docs",
          configFingerprint: "unused",
        });
        const conversationId = uuidv7();
        const missingId = uuidv7();
        const file = yield* uploadText(seed.userId, "first.txt", "First turn file");
        const callsBefore = streamPrompts.length;
        const failure = yield* chat
          .sendMessage({
            userId: seed.userId,
            conversation: { kind: "new", id: conversationId },
            modelId: textModelId,
            content: "first turn",
            attachmentIds: [file.id],
            searchEnabled: false,
            researchEnabled: false,
            integrationChoices: [
              { connectionId, enabled: true },
              { connectionId: missingId, enabled: false },
            ],
          })
          .pipe(Effect.flip);
        const attachmentRepo = yield* AttachmentRepo;
        return {
          failure,
          conversation: yield* db
            .select()
            .from(conversations)
            .where(eq(conversations.id, conversationId)),
          choices: yield* db
            .select()
            .from(conversationIntegrations)
            .where(eq(conversationIntegrations.conversationId, conversationId)),
          messages: yield* repo.listMessages(conversationId),
          files: yield* attachmentRepo.listWithBlobsByIds(seed.userId, [file.id]),
          links: yield* db
            .select()
            .from(messageAttachments)
            .where(eq(messageAttachments.attachmentId, file.id)),
          calls: streamPrompts.length - callsBefore,
          missingId,
        };
      }),
    );
    expect(result.failure).toMatchObject({
      _tag: "IntegrationNotAvailable",
      connectionId: result.missingId,
    });
    expect(result.conversation).toEqual([]);
    expect(result.choices).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.links).toEqual([]);
    expect(result.calls).toBe(0);
  });

  it("refuses a suspended sender before opening a live turn", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const seed = yield* seedAnswered(textModelId);
        yield* db.update(user).set({ banned: true }).where(eq(user.id, seed.userId));
        const failure = yield* chat
          .sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "denied",
            attachmentIds: [],
            searchEnabled: false,
            researchEnabled: false,
          })
          .pipe(Effect.flip);
        return { failure, messages: yield* repo.listMessages(seed.conversation.id) };
      }),
    );
    expect(result.failure).toMatchObject({ _tag: "AccountIneligible", reason: "banned" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.some((message) => message.status === "streaming")).toBe(false);
  });
});

describe("queued turns", () => {
  const queuedInput = () => ({
    modelId: textModelId,
    searchEnabled: false,
    researchEnabled: false,
  });
  it("refuses a same-id replacement after validation, keeping its new files and options queued", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* seedAnswered(textModelId);
        const firstFile = yield* uploadText(seed.userId, "first.txt", "First");
        const nextFile = yield* uploadText(seed.userId, "next.txt", "Next");
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "first",
          attachmentIds: [firstFile.id],
          input: queuedInput(),
        });
        const validated = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const promote = repo.promoteNextQueuedTurn;
        const paused = vi.spyOn(repo, "promoteNextQueuedTurn").mockImplementationOnce((input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(validated, undefined);
            yield* Deferred.await(proceed);
            return yield* promote(input);
          }),
        );
        const pending = yield* Effect.forkChild(
          chat.dispatchQueuedMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
          }),
        );
        yield* Deferred.await(validated);
        yield* repo.replaceQueueEntry({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
          content: "replacement",
          attachmentIds: [nextFile.id],
          input: {
            ...queuedInput(),
            modelId: visionModelId,
            reasoningEffort: null,
            collectionIds: [],
            skillIds: [],
          },
        });
        yield* Deferred.succeed(proceed, undefined);
        const outcome = yield* Fiber.join(pending).pipe(
          Effect.ensuring(Effect.sync(() => paused.mockRestore())),
        );
        const queue = yield* repo.listQueue(seed.conversation.id);
        yield* repo.setQueueEntryError(entry.id, entry.revision, "stale validation failed");
        const afterError = yield* repo.listQueue(seed.conversation.id);
        return {
          outcome,
          queue,
          afterError,
          transcript: yield* repo.listMessages(seed.conversation.id),
          nextFileId: nextFile.id,
        };
      }),
    );
    expect(result.outcome).toEqual({ started: false });
    expect(result.transcript).toHaveLength(2);
    expect(result.queue).toMatchObject([
      {
        revision: 1,
        content: "replacement",
        input: { modelId: visionModelId },
        attachments: [{ id: result.nextFileId }],
        lastError: null,
      },
    ]);
    expect(result.afterError[0]?.lastError).toBeNull();
  });

  it("annotates the selected failing entry instead of the healthy head", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* seedAnswered(textModelId);
        const first = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "healthy",
          attachmentIds: [],
          input: queuedInput(),
        });
        const selected = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "invalid",
          attachmentIds: [],
          input: { ...queuedInput(), modelId: uuidv7() },
        });
        const failure = yield* chat
          .sendQueuedNow({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            entryId: selected.id,
          })
          .pipe(Effect.flip);
        const queue = yield* repo.listQueue(seed.conversation.id);
        const ready = yield* repo.listQueuedConversations({
          userId: seed.userId,
          limit: 20,
        });
        return {
          failure,
          queue,
          firstId: first.id,
          selectedId: selected.id,
          ready: ready.some((row) => row.conversationId === seed.conversation.id),
        };
      }),
    );
    expect(result.failure).toMatchObject({ _tag: "ModelNotFound" });
    expect(result.queue.find((entry) => entry.id === result.firstId)?.lastError).toBeNull();
    expect(result.queue.find((entry) => entry.id === result.selectedId)?.lastError).toEqual(
      expect.any(String),
    );
    expect(result.ready).toBe(true);
  });

  it("holds imported files through automatic dispatch and releases only a selected Send now", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* seedAnswered(textModelId);
        const file = yield* uploadText(seed.userId, "imported.txt", "Imported file");
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "imported",
          attachmentIds: [file.id],
          input: queuedInput(),
        });
        yield* repo.setQueueEntryError(
          entry.id,
          entry.revision,
          "Imported message. Send now or edit it to continue.",
        );
        const automatic = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
        });
        const forcedAutomatic = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          force: true,
        });
        const direct = yield* repo.promoteNextQueuedTurn({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: entry.id,
          expectedRevision: entry.revision,
          force: true,
          resolve: plain,
        });
        const tail = yield* chat.queueMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "tail",
          attachmentIds: [],
          input: queuedInput(),
        });
        yield* chat.replaceQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: tail.entryId,
          content: "edited tail",
          attachmentIds: [],
          input: queuedInput(),
        });
        const held = yield* repo.listQueue(seed.conversation.id);
        const tailEntry = held.find((row) => row.id === tail.entryId)!;
        yield* repo.setQueueEntryError(tailEntry.id, tailEntry.revision, "Tail stays held");
        const beforeSend = (yield* repo.listMessages(seed.conversation.id)).length;
        const sent = yield* chat.sendQueuedNow({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
        });
        const answer = (yield* repo.listMessages(seed.conversation.id)).at(-1)!;
        yield* waitForAnswer(answer.id);
        return {
          automatic,
          forcedAutomatic,
          direct,
          held,
          beforeSend,
          sent,
          queue: yield* repo.listQueue(seed.conversation.id),
          fileId: file.id,
        };
      }),
    );
    expect(result.automatic).toEqual({ started: false });
    expect(result.forcedAutomatic).toEqual({ started: false });
    expect(result.direct).toEqual({ promoted: false, reason: "held" });
    expect(result.beforeSend).toBe(2);
    expect(result.held[0]?.attachments).toMatchObject([{ id: result.fileId }]);
    expect(result.sent).toEqual({ started: true });
    expect(result.queue).toMatchObject([{ content: "edited tail", lastError: "Tail stays held" }]);
  });

  it("does not let a late dispatch failure hold a newly validated steer", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* setupConversation;
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "valid steer",
          attachmentIds: [],
          input: { ...queuedInput(), modelId: uuidv7() },
        });
        const failed = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const annotate = repo.setQueueEntryError;
        const paused = vi
          .spyOn(repo, "setQueueEntryError")
          .mockImplementationOnce((entryId, revision, message) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(failed, undefined);
              yield* Deferred.await(proceed);
              yield* annotate(entryId, revision, message);
            }),
          );
        return yield* Effect.gen(function* () {
          const pending = yield* Effect.forkChild(
            chat
              .dispatchQueuedMessage({
                userId: seed.userId,
                conversationId: seed.conversation.id,
              })
              .pipe(Effect.flip),
          );
          yield* Deferred.await(failed);
          const fence = {
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            generationId: seed.assistant.generationId!,
          };
          yield* chat.steerQueuedMessage({ ...fence, entryId: entry.id });
          const staleSteer = yield* repo
            .steerQueueEntry({
              ...fence,
              entryId: entry.id,
              expectedRevision: entry.revision,
            })
            .pipe(Effect.flip);
          yield* Deferred.succeed(proceed, undefined);
          const failure = yield* Fiber.join(pending);
          const queue = yield* repo.listQueue(seed.conversation.id);
          const claimed = yield* repo
            .claimSteeredEntries({
              conversationId: seed.conversation.id,
              messageId: seed.assistant.id,
              textOffset: 0,
              turnIndex: 0,
            })
            .pipe(Effect.provideService(GenerationFence, fence));
          return { failure, queue, claimed, staleSteer };
        }).pipe(Effect.ensuring(Effect.sync(() => paused.mockRestore())));
      }),
    );
    expect(result.failure).toMatchObject({ _tag: "ModelNotFound" });
    expect(result.staleSteer).toMatchObject({ _tag: "QueueEntryNotFound" });
    expect(result.queue[0]?.lastError).toBeNull();
    expect(result.queue[0]?.revision).toBe(1);
    expect(result.claimed.steered).toHaveLength(1);
    expect(result.claimed.steered[0]?.content).toBe("valid steer");
  });

  it("never claims a held steer until it is deliberately steered again", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "imported steer",
          attachmentIds: [],
          input: queuedInput(),
        });
        const steer = {
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
          expectedRevision: entry.revision,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        };
        yield* repo.steerQueueEntry(steer);
        const current = (yield* repo.listQueue(seed.conversation.id))[0]!;
        yield* repo.setQueueEntryError(
          entry.id,
          current.revision,
          "Imported message. Send now or edit it to continue.",
        );
        const claim = repo
          .claimSteeredEntries({
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            textOffset: 0,
            turnIndex: 0,
          })
          .pipe(Effect.provideService(GenerationFence, steer));
        const held = yield* claim;
        const queue = yield* repo.listQueue(seed.conversation.id);
        yield* repo.steerQueueEntry({ ...steer, expectedRevision: queue[0]!.revision });
        const released = yield* claim;
        return { held, queue, released };
      }),
    );
    expect(result.held).toEqual({ steered: [], held: false });
    expect(result.queue).toHaveLength(1);
    expect(result.released.steered).toHaveLength(1);
    expect(result.released.steered[0]?.content).toBe("imported steer");
  });

  it.each(["unapproved", "banned"] as const)(
    "rolls back a queued transfer for an %s account",
    async (reason) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const chat = yield* ChatService;
          const db = yield* Db;
          const seed = yield* seedAnswered(textModelId);
          const file = yield* uploadText(seed.userId, "queued.txt", "Retain me");
          const entry = yield* repo.enqueue({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            content: "next",
            attachmentIds: [file.id],
            input: queuedInput(),
          });
          if (reason === "unapproved")
            yield* db
              .update(userApprovals)
              .set({ status: "rejected" })
              .where(eq(userApprovals.userId, seed.userId));
          else yield* db.update(user).set({ banned: true }).where(eq(user.id, seed.userId));
          const failure = yield* chat
            .dispatchQueuedMessage({ userId: seed.userId, conversationId: seed.conversation.id })
            .pipe(Effect.flip);
          return {
            failure,
            queue: yield* repo.listQueue(seed.conversation.id),
            transcript: yield* repo.listMessages(seed.conversation.id),
            entryId: entry.id,
            fileId: file.id,
          };
        }),
      );
      expect(result.failure).toMatchObject({ _tag: "AccountIneligible", reason });
      expect(result.transcript).toHaveLength(2);
      expect(result.queue).toMatchObject([
        { id: result.entryId, content: "next", attachments: [{ id: result.fileId }] },
      ]);
      expect(result.queue[0]?.lastError).toEqual(expect.any(String));
    },
  );

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
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: second.id,
          expectedRevision: second.revision,
          resolve: plain,
        });
        const promoted = yield* repo.promoteNextQueuedTurn({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: first.id,
          expectedRevision: first.revision,
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
        yield* repo.setQueueEntryError(failedEntry.id, failedEntry.revision, "model gone");

        const stopped = yield* setupConversation;
        yield* finished(stopped, "aborted");
        yield* queue(stopped);

        const computer = yield* setupComputerConversation(setupConversation);
        yield* finished(computer, "complete");
        yield* queue(computer);

        const listed = (userId?: string) =>
          repo
            .listQueuedConversations({ limit: 1000, userId })
            .pipe(Effect.map((rows) => new Set(rows.map((row) => row.conversationId))));
        const all = yield* listed();
        return {
          ready: all.has(ready.conversation.id),
          asking: all.has(asking.conversation.id),
          failed: all.has(failed.conversation.id),
          stopped: all.has(stopped.conversation.id),
          computer: all.has(computer.conversation.id),
          computerForItsOwner: (yield* listed(computer.userId)).has(computer.conversation.id),
          computerForAnotherUser: (yield* listed(ready.userId)).has(computer.conversation.id),
        };
      }),
    );

    expect(result).toEqual({
      ready: true,
      asking: false,
      failed: false,
      stopped: false,
      computer: true,
      computerForItsOwner: true,
      computerForAnotherUser: false,
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
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: entry.id,
          expectedRevision: entry.revision,
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
        const failedEntry = yield* queue(failed);
        yield* repo.setQueueEntryError(failedEntry.id, failedEntry.revision, "model gone");
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
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: entry.id,
          expectedRevision: entry.revision,
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
      expectedRevision: entry.revision,
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
      generationId: seed.assistant.generationId!,
      modelId: textModelId,
    });
    yield* waitForAnswer(seed.assistant.id);
    authoringScript = null;
    const steer = (yield* repo.listMessages(seed.conversation.id)).find(
      (message) => message.steeredIntoMessageId,
    )!;
    return { seed, file, steer, promptsBefore };
  });

  it.each(["unapproved", "banned"] as const)(
    "holds fresh steers for an %s account without failing its accepted answer",
    async (reason) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const chat = yield* ChatService;
          const engine = yield* StreamEngine;
          const db = yield* Db;
          const bus = yield* SyncBus;
          const seed = yield* setupConversation;
          const file = yield* uploadText(seed.userId, "held-steer.txt", "Private queued file");
          const fence = {
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            generationId: seed.assistant.generationId!,
          };
          const enqueue = (content: string, attachmentIds: string[] = []) =>
            repo.enqueue({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              content,
              attachmentIds,
              input: queuedInput(),
            });
          const selected = yield* enqueue("Fresh suspended input", [file.id]);
          const alreadyHeld = yield* enqueue("Already held");
          const stale = yield* enqueue("Other generation");
          const ordinary = yield* enqueue("Ordinary queued input");
          for (const entry of [selected, alreadyHeld, stale])
            yield* repo.steerQueueEntry({
              ...fence,
              entryId: entry.id,
              expectedRevision: entry.revision,
            });
          const current = yield* repo.listQueue(seed.conversation.id);
          yield* repo.setQueueEntryError(
            alreadyHeld.id,
            current.find((entry) => entry.id === alreadyHeld.id)!.revision,
            "Keep existing hold",
          );
          yield* db
            .update(conversationQueueEntries)
            .set({ steerGenerationId: uuidv7() })
            .where(eq(conversationQueueEntries.id, stale.id));
          const ready = yield* Deferred.make<void>();
          const collector = yield* Effect.forkChild(
            bus.subscribe(seed.userId).pipe(
              Stream.tap((event) =>
                event.type === "sync.ready" ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
              Stream.filter(
                (event) =>
                  event.type === "conversation.queue.changed" &&
                  event.conversationId === seed.conversation.id,
              ),
              Stream.take(1),
              Stream.runCollect,
            ),
          );
          yield* Deferred.await(ready);
          const boundary = yield* Deferred.make<void>();
          const proceed = yield* Deferred.make<void>();
          const claim = repo.claimSteeredEntries;
          const paused = vi.spyOn(repo, "claimSteeredEntries").mockImplementationOnce((input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(boundary, undefined);
              yield* Deferred.await(proceed);
              return yield* claim(input);
            }),
          );
          const promptsBefore = streamPrompts.length;
          let calls = 0;
          authoringScript = (input) => {
            calls += 1;
            if (calls === 1)
              return Stream.make(
                AiResponse.makePart("text-delta", { id: "t1", delta: firstRound }),
              ).pipe(
                Stream.concat(authoringTool(input, "list_agent_options", { kind: "models" })),
              ) as Stream.Stream<ChatStreamPart>;
            return Stream.make(
              AiResponse.makePart("text-delta", { id: "t2", delta: secondRound }),
              authoringFinish(),
            ) as Stream.Stream<ChatStreamPart>;
          };
          return yield* Effect.gen(function* () {
            yield* engine.startGeneration({ ...fence, modelId: textModelId });
            yield* Deferred.await(boundary);
            if (reason === "banned")
              yield* db
                .update(user)
                .set({ banned: true, banExpires: null })
                .where(eq(user.id, seed.userId));
            else
              yield* db
                .update(userApprovals)
                .set({ status: "rejected" })
                .where(eq(userApprovals.userId, seed.userId));
            yield* Deferred.succeed(proceed, undefined);
            yield* waitForAnswer(seed.assistant.id);
            const events = Array.from(yield* Fiber.join(collector));
            const final = yield* repo.getMessage(seed.assistant.id);
            const queue = yield* repo.listQueue(seed.conversation.id);
            const transcript = yield* repo.listMessages(seed.conversation.id);
            yield* db.update(user).set({ banned: false }).where(eq(user.id, seed.userId));
            yield* db
              .update(userApprovals)
              .set({ status: "approved" })
              .where(eq(userApprovals.userId, seed.userId));
            const restored = yield* chat.dispatchQueuedMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
            });
            return {
              final,
              queue,
              transcript,
              events,
              restored,
              afterRestore: yield* repo.listQueue(seed.conversation.id),
              continuation: JSON.stringify(streamPrompts[promptsBefore + 1]?.content),
              calls: streamPrompts.length - promptsBefore,
              selectedId: selected.id,
              heldId: alreadyHeld.id,
              staleId: stale.id,
              ordinaryId: ordinary.id,
              fileId: file.id,
            };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                paused.mockRestore();
                authoringScript = null;
              }),
            ),
          );
        }),
      );
      expect(result.final).toMatchObject({ status: "complete", content: firstRound + secondRound });
      expect(result.calls).toBe(2);
      expect(result.transcript).toHaveLength(2);
      expect(result.continuation).not.toContain("Fresh suspended input");
      expect(result.continuation).not.toContain("Private queued file");
      expect(result.events).toHaveLength(1);
      expect(result.queue.find((entry) => entry.id === result.selectedId)).toMatchObject({
        content: "Fresh suspended input",
        lastError: "This account can’t start messages. Try Send now after access is restored.",
        attachments: [{ id: result.fileId }],
      });
      expect(result.queue.find((entry) => entry.id === result.heldId)?.lastError).toBe(
        "Keep existing hold",
      );
      expect(result.queue.find((entry) => entry.id === result.staleId)?.lastError).toBeNull();
      expect(result.queue.find((entry) => entry.id === result.ordinaryId)?.lastError).toBeNull();
      expect(result.restored).toEqual({ started: false });
      expect(result.afterRestore).toEqual(result.queue);
    },
  );

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
    // Told after it that this came mid-task, so a question does not end the work.
    expect(result.continuation.indexOf("use a different ending")).toBeLessThan(
      result.continuation.indexOf("Address it briefly, then continue the task"),
    );
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

  it("lets the answer read a file a steer brought in, by id, from the next round", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const seed = yield* setupConversation;
        const file = yield* uploadText(seed.userId, "steer.txt", "Steer file body 42");
        const entry = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "check the file",
          attachmentIds: [file.id],
          input: queuedInput(),
        });
        yield* repo.steerQueueEntry({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: entry.id,
          expectedRevision: entry.revision,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        });
        let calls = 0;
        authoringScript = (input) => {
          calls += 1;
          if (calls === 1) return authoringTool(input, "list_agent_options", { kind: "models" });
          if (calls === 2)
            return authoringTool(input, "read_attachment", {
              attachmentId: file.id,
              pattern: "body",
            });
          return Stream.make(
            AiResponse.makePart("text-delta", { id: "t", delta: "Read it." }),
            authoringFinish(),
          ) as Stream.Stream<ChatStreamPart>;
        };
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
          modelId: textModelId,
        });
        yield* waitForAnswer(seed.assistant.id);
        authoringScript = null;
        return (yield* repo.listToolCalls([seed.assistant.id])).find(
          (call) => call.toolName === "read_attachment",
        );
      }),
    );
    expect(result).toMatchObject({ status: "complete" });
    expect(result?.result).toMatchObject({ ok: true, fileName: "steer.txt", matches: 1 });
  }, 60_000);

  it("stops an answer a delete reached before it started, even after an Undo", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const seed = yield* setupConversation;
        // The turn committed, but its fiber has not registered yet: the delete
        // finds the row with nothing running to stop, and an Undo follows.
        const mark = yield* chat.deleteConversation({
          userId: seed.userId,
          conversationId: seed.conversation.id,
        });
        const restored = yield* chat.restoreConversation({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          mark: mark!,
        });
        let calls = 0;
        authoringScript = () => {
          calls += 1;
          return Stream.make(
            AiResponse.makePart("text-delta", { id: "t", delta: "Too late." }),
            authoringFinish(),
          ) as Stream.Stream<ChatStreamPart>;
        };
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
          modelId: textModelId,
        });
        yield* waitForAnswer(seed.assistant.id);
        authoringScript = null;
        return {
          restored,
          status: (yield* repo.getMessage(seed.assistant.id))?.status,
          calls,
        };
      }),
    );
    expect(result).toEqual({ restored: true, status: "aborted", calls: 0 });
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
          expectedRevision: entry.revision,
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
          generationId: seed.assistant.generationId!,
          modelId: imageModelId,
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
    // Live: the round's call and results, then the steer, the draft data the
    // call changed (sent after the rounds, never rewritten ahead of them) and
    // the reminder that the steer came mid-task, then the next call.
    expect(promptShape(result.continuation).slice(-6)).toEqual([
      "assistant:turn0",
      "tool",
      "user:steer",
      "user:other",
      "assistant:other",
      "user:other",
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
          expectedRevision: steered.revision,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
        });
        // The fake model answers in one call with no tools: no boundary comes.
        yield* engine.startGeneration({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          generationId: seed.assistant.generationId!,
          modelId: textModelId,
        });
        yield* waitForAnswer(seed.assistant.id);
        const queue = yield* repo.listQueue(seed.conversation.id);
        const promoted = yield* repo.promoteNextQueuedTurn({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          expectedEntryId: queue[0]!.id,
          expectedRevision: queue[0]!.revision,
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
        const seed = yield* setupConversation;
        const first = yield* repo.enqueue({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          content: "queued first",
          attachmentIds: [],
          input: queuedInput(),
        });
        // Held, so the answer the chosen entry starts does not go on to start it.
        yield* repo.setQueueEntryError(first.id, first.revision, "held");
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
          generationId: seed.assistant.generationId!,
          modelId: textModelId,
        });
        yield* Deferred.await(reached);
        // The parked answer stays parked; only Stop may end it.
        hold = null;
        const sent = yield* chat.sendQueuedNow({
          userId: seed.userId,
          conversationId: seed.conversation.id,
          entryId: chosen.id,
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

  it.each(["stopped", "reaped"] as const)(
    "leaves a refused steer unchanged after its answer is %s",
    async (state) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const seed = yield* setupConversation;
          const file = yield* uploadText(seed.userId, "unclaimed.txt", "Keep ownership");
          const entry = yield* repo.enqueue({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            content: "Do not claim or hold",
            attachmentIds: [file.id],
            input: queuedInput(),
          });
          const fence = {
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            generationId: seed.assistant.generationId!,
          };
          yield* repo.steerQueueEntry({
            ...fence,
            entryId: entry.id,
            expectedRevision: entry.revision,
          });
          yield* db.update(user).set({ banned: true }).where(eq(user.id, seed.userId));
          if (state === "stopped")
            yield* repo.finalizeMessage({
              messageId: seed.assistant.id,
              status: "aborted",
              content: "",
            });
          else {
            yield* db
              .update(messages)
              .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
              .where(eq(messages.id, seed.assistant.id));
            yield* repo.reapExpiredGenerations();
          }
          const claim = yield* Effect.exit(
            repo
              .claimSteeredEntries({
                conversationId: seed.conversation.id,
                messageId: seed.assistant.id,
                textOffset: 0,
                turnIndex: 0,
              })
              .pipe(Effect.provideService(GenerationFence, fence)),
          );
          return {
            interrupted: Exit.hasInterrupts(claim),
            queue: yield* repo.listQueue(seed.conversation.id),
            fileId: file.id,
          };
        }),
      );
      expect(result.interrupted).toBe(true);
      expect(result.queue).toMatchObject([
        { content: "Do not claim or hold", lastError: null, attachments: [{ id: result.fileId }] },
      ]);
    },
  );

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
          expectedRevision: entry.revision,
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
    expect(result.claimed.steered).toHaveLength(1);
    expect(result.claimed.steered[0]).toMatchObject({
      content: "change course",
      steeredIntoMessageId: expect.any(String),
    });
    expect(result.queue).toEqual([]);
  });

  it("starts a queued message in a chat with a computer without any desktop app", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const seed = yield* setupComputerConversation(setupConversation);
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
        const started = yield* chat.dispatchQueuedMessage({
          userId: seed.userId,
          conversationId: seed.conversation.id,
        });
        const assistant = (yield* repo.listMessages(seed.conversation.id)).at(-1)!;
        yield* waitForAnswer(assistant.id);
        return {
          started,
          final: yield* repo.getMessage(assistant.id),
          queue: yield* repo.listQueue(seed.conversation.id),
        };
      }),
    );

    expect(result.started).toEqual({ started: true });
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
          family: "web",
          arguments: {},
        });
        yield* repo.insertToolCall({
          id: completedTool,
          messageId: seed.assistant.id,
          turnIndex: 0,
          callIndex: 1,
          providerCallId: "completed-preflight",
          toolName: "web_search",
          family: "web",
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
          generationId: seed.assistant.generationId!,
          userId: seed.userId,
          conversationId: seed.conversation.id,
          messageId: seed.assistant.id,
          modelId: "fake",
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
            generationId: seed.assistant.generationId!,
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            modelId: "fake",
            desktop: { executorId: "test-executor", browser: false },
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
          family: "web",
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
                cacheWriteTokens: null,
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
            generationId: seed.assistant.generationId!,
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            modelId: "fake",
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
    const nextGenerationId = uuidv7();
    const chunksAfter = repo.chunksAfter;
    const replayRead = vi.spyOn(repo, "chunksAfter").mockImplementationOnce((messageId, afterSeq) =>
      Effect.gen(function* () {
        // Commit the retry replacement exactly between the identity and chunk reads.
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(messages)
              .set({ generationId: nextGenerationId, status: "complete" })
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
        {
          kind: "done",
          messageId: seed.assistant.id,
          generationId: nextGenerationId,
          status: "error",
        },
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
              generationId: seed.assistant.generationId!,
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: seed.assistant.id,
              modelId: "fake",
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
          generationId: assistant.generationId!,
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
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
          generationId: assistant.generationId!,
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
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
        generationId: result.generationId,
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
          family: "web",
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
            resolve: plainResolve,
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
          generationId: assistant.generationId!,
        });
        const settled = yield* repo.getMessage(assistant.id);
        const toolCalls = yield* repo.listToolCalls([assistant.id]);
        const next = yield* repo.createTurn({
          resolve: plainResolve,
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
          generationId: assistant.generationId!,
          userId,
          conversationId: conversation.id,
          messageId: assistant.id,
          modelId: "fake",
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
            resolve: plainResolve,
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
          resolve: plainResolve,
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
  it("lets a conditional fire notify but not ask, and tells a later reply why it cannot notify", async () => {
    const offered: string[][] = [];
    const prompts: string[] = [];
    authoringScript = (input) => {
      offered.push(Object.keys(input.toolkit?.tools ?? {}));
      prompts.push(JSON.stringify(input.prompt));
      if (offered.length === 1) return authoringTool(input, "notify_user", { message: "It fell." });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    try {
      const fired = await runtime.runPromise(
        Effect.gen(function* () {
          const seed = yield* setupConversation;
          const chat = yield* ChatService;
          const engine = yield* StreamEngine;
          const db = yield* Db;
          const scheduleId = uuidv7();
          const runId = uuidv7();
          yield* db.insert(schedules).values({
            id: scheduleId,
            userId: seed.userId,
            name: "Watch",
            prompt: "Tell me only if it falls.",
            scheduleText: "hourly",
            cron: "0 * * * *",
            timezone: "UTC",
            notify: "conditional",
          });
          yield* db.insert(scheduleRuns).values({ id: runId, scheduleId, status: "pending" });
          const turn = yield* chat.runScheduledTurn({
            userId: seed.userId,
            scheduleId,
            scheduleRunId: runId,
            prompt: "Tell me only if it falls.",
            modelId: textModelId,
            agentId: null,
            searchEnabled: false,
            researchEnabled: false,
            collectionIds: [],
            skillIds: [],
            integrationGrants: [],
            timeZone: "UTC",
            target: { kind: "new" },
            onSettled: Effect.void,
          });
          yield* engine.subscribe(turn.assistantMessageId, 0).pipe(Stream.runDrain);
          const [run] = yield* db
            .select({ notifyMessage: scheduleRuns.notifyMessage })
            .from(scheduleRuns)
            .where(eq(scheduleRuns.id, runId));
          return { userId: seed.userId, conversationId: turn.conversationId, run };
        }),
      );
      // Nobody is there to answer a question; the schedule leaves notifying to the answer.
      expect(offered[0]).toContain("notify_user");
      expect(offered[0]).not.toContain("ask_user");
      expect(fired.run?.notifyMessage).toBe("It fell.");

      await runtime.runPromise(
        Effect.gen(function* () {
          const chat = yield* ChatService;
          const engine = yield* StreamEngine;
          const sent = yield* chat.sendMessage({
            userId: fired.userId,
            conversation: { kind: "existing", id: fired.conversationId },
            modelId: textModelId,
            content: "Can you notify me again?",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          });
          yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
        }),
      );
      // The person's own reply cannot notify, and is told so rather than
      // reading the earlier call as one it never made.
      expect(offered.at(-1)).not.toContain("notify_user");
      expect(offered.at(-1)).toContain("ask_user");
      expect(prompts.at(-1)).toContain("Only a run can notify");
    } finally {
      authoringScript = null;
    }
  });

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
        const runId = uuidv7();
        yield* db.insert(scheduleRuns).values({ id: runId, scheduleId, status: "pending" });
        const turn = yield* chat.runScheduledTurn({
          userId: seed.userId,
          scheduleId,
          scheduleRunId: runId,
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
          integrationGrants: [],
          timeZone: "Europe/Berlin",
          target: { kind: "new" },
          onSettled: Effect.void,
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
        // Each fire has its pending run, as the scheduler writes one, and binds it.
        const fire = () =>
          Effect.gen(function* () {
            const runId = uuidv7();
            yield* db.insert(scheduleRuns).values({ id: runId, scheduleId, status: "pending" });
            return yield* chat.runScheduledTurn({
              userId: seed.userId,
              scheduleId,
              scheduleRunId: runId,
              prompt: "Summarize yesterday.",
              modelId: textModelId,
              // Ignored for an existing chat: an agent cannot change after creation.
              agentId: "some-agent",
              searchEnabled: false,
              researchEnabled: false,
              collectionIds: [],
              skillIds: [],
              integrationGrants: [],
              timeZone: "Europe/Berlin",
              target: { kind: "existing", conversationId: seed.conversation.id },
              onSettled: Effect.void,
            });
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
        const runs = yield* db
          .select({ status: scheduleRuns.status, conversationId: scheduleRuns.conversationId })
          .from(scheduleRuns)
          .where(eq(scheduleRuns.scheduleId, scheduleId));
        return {
          first,
          second,
          runs,
          added: after - before,
          conversation,
          agent: (yield* repo.getConversationDefaults(seed.conversation.id)).agent,
          listed: listed.conversations.find((c) => c.id === seed.conversation.id),
        };
      }),
    );
    expect(result.first.conversationId).toBe(result.conversation!.id);
    expect(result.second.conversationId).toBe(result.conversation!.id);
    // Two runs, each a user prompt and an answer, in the one chat, both started.
    expect(result.added).toBe(4);
    expect(result.runs).toEqual([
      { status: "started", conversationId: result.conversation!.id },
      { status: "started", conversationId: result.conversation!.id },
    ]);
    // Not created by the schedule, but marked as the one it runs in.
    expect(result.conversation?.scheduleId).toBeNull();
    expect(result.listed).toMatchObject({ scheduled: true });
    expect(result.agent).toBeNull();
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
        .values({ id: attachmentId, userId, blobId, fileName: "shot.png", mediaType: "image/png" });
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

  it("names an earlier image to a model without vision, so a send to it still runs", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, userMessage } = yield* seedAnswered(visionModelId);
        yield* attachImage(userId, userMessage.id);
        const before = streamPrompts.length;
        const sent = yield* chat.sendMessage({
          userId,
          conversation: { kind: "existing", id: conversation.id },
          modelId: textModelId,
          content: "And now?",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        });
        yield* engine.subscribe(sent.assistantMessageId, 0).pipe(Stream.runDrain);
        return {
          prompts: streamPrompts.slice(before),
          answer: yield* repo.getMessage(sent.assistantMessageId),
        };
      }),
    );

    expect(result.answer?.status).toBe("complete");
    const parts = result.prompts.flatMap((prompt) =>
      prompt.content.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : (message.content as ReadonlyArray<{ type: string }>),
      ),
    );
    expect(parts.some((part) => part.type === "file")).toBe(false);
    expect(JSON.stringify(result.prompts)).toContain("omitted: this model cannot view images");
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

  it("retries a later answer on a model that cannot see an earlier turn's image", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const engine = yield* StreamEngine;
        const repo = yield* ChatRepo;
        const { userId, conversation, userMessage } = yield* seedAnswered(visionModelId);
        yield* attachImage(userId, userMessage.id);
        const later = yield* chat.sendMessage({
          userId,
          conversation: { kind: "existing", id: conversation.id },
          modelId: visionModelId,
          content: "And now?",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        });
        yield* engine.subscribe(later.assistantMessageId, 0).pipe(Stream.runDrain);
        // The image belongs to the first turn, so the second can switch models.
        const retried = yield* chat.retryMessage({
          userId,
          conversationId: conversation.id,
          messageId: later.assistantMessageId,
          modelId: textModelId,
        });
        yield* engine.subscribe(retried.assistantMessageId, 0).pipe(Stream.runDrain);
        return yield* repo.getMessage(retried.assistantMessageId);
      }),
    );
    expect(result?.status).toBe("complete");
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
              imageOutput: false,
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
          const branchAnswer = (yield* repo.listMessages(branch.id)).findLast(
            (message) => message.role === "assistant",
          )!;
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
              imageOutput: false,
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
                family: "ask",
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
        yield* db.execute(sql`insert into providers (id, name, preset, base_url, api_key_ciphertext)
          values (${providerId}, 'unsupported-effort', 'custom', 'http://x', 'x')`);
        yield* db.insert(models).values({
          id: modelId,
          providerId,
          modelKey: `unsupported-${modelId}`,
          displayName: "Unsupported transport",
          type: "chat",
          capabilities: {
            imageOutput: false,
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
          imageOutput: false,
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
                generationId: message.generationId!,
                modelId: imageModelId,
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
            resolve: plainResolve,
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
            (candidate) => candidate.kind === "chunk" && candidate.chunkKind === "file",
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
            resolve: plainResolve,
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
          expect(JSON.stringify(prompts[1])).toContain(`/api/files/${initialId}`);
          expect(JSON.stringify(prompts[2])).toContain(`/api/files/${initialId}`);
          expect(JSON.stringify(prompts[2])).toContain(`/api/files/${editedId}`);
          const texts = prompts[2]!.content.flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          );
          expect(
            texts.filter((text) => text.includes("Replace the original image with a blue image")),
          ).toHaveLength(1);
          expect(
            texts.filter((text) => text.includes("Make the latest blue image larger")),
          ).toHaveLength(1);
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
          generationId: assistant.generationId!,
          modelId: imageModelId,
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
        // A replay reports when each chunk was written; otherwise it is the live stream.
        expect(live).toEqual(
          replay.map((event) => {
            if (event.kind !== "chunk") return event;
            expect(event.at).toEqual(expect.any(Number));
            const { at: _at, ...rest } = event;
            return rest;
          }),
        );
        expect(
          live.filter((event) => event.kind === "chunk").map((event) => event.chunkKind),
        ).toEqual(["text", "file", "text"]);
        expect(live.at(-1)).toMatchObject({
          kind: "done",
          status: "complete",
          generationId: assistant.generationId,
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
          providerReplay: {
            turns: [{ unit: { reasoningDetails: [{ data: "private-replay" }] } }],
          },
        });
      }),
    );
  });
});

describe("ui block images", () => {
  const answer = (...queries: string[]) => [
    AiResponse.makePart("text-delta", { id: "t", delta: "Here:\n```ui\n" }),
    AiResponse.makePart("text-delta", {
      id: "t",
      delta: queries.map((q) => `<image query="${q}"/>`).join("\n"),
    }),
    AiResponse.makePart("text-delta", { id: "t", delta: "\n```\nDone." }),
    AiResponse.makePart("finish", {
      reason: "stop",
      usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
    }),
  ];
  const generate = (searchEnabled: boolean) =>
    Effect.gen(function* () {
      const engine = yield* StreamEngine;
      const seed = yield* setupConversation;
      yield* setAttemptSearch(seed.assistant.id, searchEnabled);
      yield* engine.startGeneration({
        userId: seed.userId,
        conversationId: seed.conversation.id,
        messageId: seed.assistant.id,
        generationId: seed.assistant.generationId!,
        modelId: textModelId,
      });
      const events = yield* engine
        .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
        .pipe(Stream.runCollect);
      return { ...seed, events: [...events] };
    });

  it("stores found images with the answer, out of its files, and branches them", async () => {
    terminalFixtures = [answer("gear hub", "nothing here")];
    imageSearch = (query) =>
      query === "gear hub"
        ? ["https://img.test/broken", "https://img.test/a", "https://img.test/b"]
        : [];
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const attachmentRepo = yield* AttachmentRepo;
          const files = yield* AttachmentService;
          const { userId, conversation, assistant, events } = yield* generate(true);
          const message = yield* repo.getMessage(assistant.id);
          expect(message!.status).toBe("complete");
          const images = message!.assistantOutput!.images!;
          expect(images["nothing here"]).toEqual({ status: "unavailable", items: [] });
          const found = images["gear hub"]!;
          expect(found.status).toBe("resolved");
          expect(found.items.map((item) => item.pageUrl)).toEqual([
            "https://img.test/a/page",
            "https://img.test/b/page",
          ]);
          expect(message!.assistantOutput!.files).toEqual([]);
          const bytes = yield* files.read({ userId, attachmentId: found.items[0]!.attachmentId });
          expect(Buffer.from(bytes.bytes).equals(generatedPng)).toBe(true);
          // Live subscribers heard about it before the answer finished.
          const announced = events.flatMap((event) =>
            event.kind === "lookups" ? [event.lookups] : [],
          );
          expect(announced.at(-1)?.images["gear hub"]?.status).toBe("resolved");
          // Never listed as the answer's files, nor as the chat's.
          expect(yield* attachmentRepo.listForMessages([assistant.id])).toEqual([]);
          expect(yield* attachmentRepo.listWithBlobsForMessages([assistant.id])).toEqual([]);
          expect(yield* attachmentRepo.listForConversation(userId, conversation.id)).toEqual([]);

          const branch = yield* repo.cloneConversationPrefix({
            userId,
            sourceConversationId: conversation.id,
            throughMessageId: assistant.id,
          });
          const copied = (yield* repo.listMessages(branch.id)).find((m) => m.role === "assistant")!;
          const copiedFound = copied.assistantOutput!.images!["gear hub"]!;
          expect(copiedFound.items).toHaveLength(2);
          expect(copiedFound.items[0]!.attachmentId).not.toBe(found.items[0]!.attachmentId);
          const copiedBytes = yield* files.read({
            userId,
            attachmentId: copiedFound.items[0]!.attachmentId,
          });
          expect(Buffer.from(copiedBytes.bytes).equals(generatedPng)).toBe(true);
          expect(yield* attachmentRepo.listForMessages([copied.id])).toEqual([]);
        }),
      );
    } finally {
      terminalFixtures = undefined;
      imageSearch = undefined;
    }
  });

  it("records that images need web search when the attempt had none, without searching", async () => {
    terminalFixtures = [answer("anything")];
    imageSearch = () => {
      throw new Error("searched without web search");
    };
    const fetchesBefore = imageFetches.length;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const { assistant } = yield* generate(false);
          const message = yield* repo.getMessage(assistant.id);
          expect(message!.assistantOutput!.images).toEqual({
            anything: { status: "search_off", items: [] },
          });
          expect(imageFetches.length).toBe(fetchesBefore);
        }),
      );
    } finally {
      terminalFixtures = undefined;
      imageSearch = undefined;
    }
  });
});

describe("ui block maps", () => {
  const answer = [
    AiResponse.makePart("text-delta", { id: "t", delta: "Your day trip:\n```ui\n<map>\n" }),
    AiResponse.makePart("text-delta", {
      id: "t",
      delta: [
        '<pin place="Berlin Hauptbahnhof"/>',
        '<pin place="Atlantis"/>',
        '<route mode="drive" stops={["Berlin Hauptbahnhof", "Potsdam"]}/>',
      ].join("\n"),
    }),
    AiResponse.makePart("text-delta", { id: "t", delta: "\n</map>\n```\nEnjoy." }),
    AiResponse.makePart("finish", {
      reason: "stop",
      usage: new AiResponse.Usage({ inputTokens: {}, outputTokens: {} }),
    }),
  ];

  it("stores the places and routes a map named, and tells subscribers", async () => {
    terminalFixtures = [answer];
    const before = mapLookupCalls.length;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const engine = yield* StreamEngine;
          const seed = yield* setupConversation;
          yield* engine.startGeneration({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            generationId: seed.assistant.generationId!,
            modelId: textModelId,
          });
          const events = yield* engine
            .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
            .pipe(Stream.runCollect);
          const output = (yield* repo.getMessage(seed.assistant.id))!.assistantOutput!;
          // Not web search: maps resolve with search off.
          expect(output.places?.["Berlin Hauptbahnhof"]).toMatchObject({ status: "resolved" });
          expect(output.places?.["Atlantis"]).toEqual({ status: "unavailable" });
          const key = routeKey({ mode: "drive", stops: ["Berlin Hauptbahnhof", "Potsdam"] });
          expect(output.routes?.[key]).toMatchObject({ status: "resolved", distance: 34000 });
          // Each place once, though the route names the station again.
          expect(mapLookupCalls.slice(before).toSorted()).toEqual([
            "place:Atlantis",
            "place:Berlin Hauptbahnhof",
            "place:Potsdam",
            "route:drive:2",
          ]);
          const last = [...events].flatMap((e) => (e.kind === "lookups" ? [e.lookups] : [])).at(-1);
          expect(last?.routes[key]?.status).toBe("resolved");
        }),
      );
    } finally {
      terminalFixtures = undefined;
    }
  });
  it("marks every place and route as maps off when an admin switched maps off, asking nothing", async () => {
    terminalFixtures = [answer];
    const before = mapLookupCalls.length;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const tools = yield* ToolsRepo;
          const engine = yield* StreamEngine;
          yield* tools.updateTool("maps", { enabled: false });
          try {
            const seed = yield* setupConversation;
            yield* engine.startGeneration({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: seed.assistant.id,
              generationId: seed.assistant.generationId!,
              modelId: textModelId,
            });
            yield* engine
              .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
              .pipe(Stream.runCollect);
            const output = (yield* repo.getMessage(seed.assistant.id))!.assistantOutput!;
            const key = routeKey({ mode: "drive", stops: ["Berlin Hauptbahnhof", "Potsdam"] });
            expect(output.places).toEqual({
              "Berlin Hauptbahnhof": { status: "maps_off" },
              Atlantis: { status: "maps_off" },
              Potsdam: { status: "maps_off" },
            });
            expect(output.routes).toEqual({ [key]: { status: "maps_off" } });
            expect(mapLookupCalls.length).toBe(before);
          } finally {
            yield* tools.updateTool("maps", { enabled: true });
          }
        }),
      );
    } finally {
      terminalFixtures = undefined;
    }
  });
});

describe("interactive answers setting", () => {
  const offered = (prompt: Prompt.Prompt) =>
    JSON.stringify(prompt).includes("builtin:interactive-ui");
  const answer = () =>
    Effect.gen(function* () {
      const engine = yield* StreamEngine;
      const seed = yield* setupConversation;
      const before = streamPrompts.length;
      yield* engine.startGeneration({
        userId: seed.userId,
        conversationId: seed.conversation.id,
        messageId: seed.assistant.id,
        generationId: seed.assistant.generationId!,
        modelId: textModelId,
      });
      yield* engine
        .subscribe(seed.assistant.id, 0, seed.assistant.generationId ?? undefined)
        .pipe(Stream.runCollect);
      return streamPrompts.slice(before);
    });

  it("offers the skill by default and not once an admin switches it off", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const tools = yield* ToolsRepo;
        expect((yield* answer()).some(offered)).toBe(true);
        yield* tools.updateTool("interactive_ui", { enabled: false });
        try {
          const prompts = yield* answer();
          expect(prompts.length).toBeGreaterThan(0);
          expect(prompts.some(offered)).toBe(false);
        } finally {
          yield* tools.updateTool("interactive_ui", { enabled: true });
        }
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
                metadata: { modelClient: { cost: 0.04 } },
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
              generationId: assistant.generationId!,
              modelId: textModelId,
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
            metadata: { modelClient: { cost: 0.04 } },
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
              generationId: assistant.generationId!,
              modelId: imageModelId,
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
            generationId: assistant.generationId!,
            modelId: imageModelId,
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

  // Only the offer decides a call's family. These names belong to families
  // this attempt was not offered: no pinned module, no desktop browser, no
  // conditional schedule fire. The SDK still forwards each part.
  it.each(["custom_nope__lookup", "browser_click", "notify_user"])(
    "treats %s, which this attempt was not offered, as an unknown tool and keeps no row",
    async (name) => {
      const seed = await runtime.runPromise(setupConversation);
      const conversationId = (
        await runtime.runPromise(
          ChatRepo.use((repo) =>
            repo.createConversation({ userId: seed.userId, modelId: textModelId }),
          ),
        )
      ).id;
      let round = 0;
      authoringScript = () =>
        ++round === 1
          ? (Stream.make(
              AiResponse.makePart("tool-call", {
                id: uuidv7(),
                name,
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
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        expect(detail.messages.at(-1)).toMatchObject({ status: "complete" });
        expect(detail.toolCalls).toEqual([]);
      } finally {
        authoringScript = null;
      }
    },
    60_000,
  );

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
          {
            name: "q3.pdf",
            mediaType: "application/pdf",
            delivery: "publish",
            showModel: false,
            bytes: pdf,
          },
          {
            name: "q3.csv",
            mediaType: "text/csv",
            delivery: "publish",
            showModel: true,
            bytes: csv,
          },
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
      // The tool row never carries the bytes.
      const call = detail.toolCalls.find((row) => row.messageId === assistantMessageId)!;
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

  it("revises a custom working file repeatedly before publishing one attachment", async () => {
    const seed = await runtime.runPromise(setupConversation);
    const name = `editor_${seed.userId.slice(-8)}`;
    const created = await runtime.runPromise(
      CustomToolRepo.use((repo) =>
        repo.create({
          slug: name,
          name: "Editor",
          description: "",
          createdBy: seed.userId,
          build: {
            source: "",
            dependencies: [],
            compiled: "",
            functions: [
              {
                key: "revise",
                name: "Revise",
                description: "Revise a draft.",
                modelName: `custom_${name}__revise`,
                parametersSchema: { type: "object", properties: { ref: { type: "string" } } },
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
    const calls = created.functions[0]!.modelName;
    let round = 0;
    let nextRef: string | undefined;
    let revisions = 0;
    customToolRun = (input) => {
      const ref = (input.args as { ref?: string }).ref;
      if (!ref)
        return Effect.succeed({
          ok: true,
          output: "Draft prepared.",
          logs: [],
          durationMs: 1,
          files: [
            {
              name: "notes.txt",
              mediaType: "text/plain",
              delivery: "working",
              showModel: false,
              bytes: Buffer.from("0"),
            },
          ],
        });
      return Effect.gen(function* () {
        const source = yield* input.resolveFile!(ref);
        if (source.ref.kind !== "working") throw new Error("Expected a working revision.");
        expect(Buffer.from(source.bytes).toString()).toBe(String(revisions));
        revisions += 1;
        return {
          ok: true,
          output: "Draft updated.",
          logs: [],
          durationMs: 1,
          files: [
            {
              name: "notes.txt",
              mediaType: "text/plain",
              delivery: "working" as const,
              showModel: false,
              replaces: source.ref,
              bytes: Buffer.from(String(revisions)),
            },
          ],
        } satisfies CustomToolRunResult;
      }).pipe(Effect.orDie);
    };
    authoringScript = (input) => {
      round += 1;
      if (round > 1) {
        const refs = JSON.stringify(input.prompt).match(/working:[a-f\d-]+@\d+/g);
        nextRef = refs?.at(-1);
      }
      if (round <= 7) return authoringTool(input, calls, nextRef ? { ref: nextRef } : {});
      if (round === 8) return authoringTool(input, "publish_file", { ref: nextRef });
      return reply();
    };
    try {
      const { assistantMessageId } = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content: "Revise the draft six times and deliver it.",
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
      expect(detail.messages.at(-1)?.status).toBe("complete");
      expect(round).toBe(9);
      expect(revisions).toBe(6);
      expect(detail.attachments.filter((row) => row.messageId === assistantMessageId)).toHaveLength(
        1,
      );
      const customCalls = detail.toolCalls.filter((row) => row.toolName === calls);
      expect(customCalls).toHaveLength(7);
      expect(
        customCalls.every(
          (row) => (row.result as { workingFiles?: unknown[] })?.workingFiles?.length === 1,
        ),
      ).toBe(true);
      expect(detail.toolCalls.find((row) => row.toolName === "publish_file")?.status).toBe(
        "complete",
      );
    } finally {
      authoringScript = null;
      customToolRun = null;
    }
  }, 60_000);

  describe("unpublished working files across answers", () => {
    const keptSetup = Effect.gen(function* () {
      const seed = yield* setupConversation;
      const name = `keeper_${seed.userId.slice(-8)}`;
      const created = yield* CustomToolRepo.use((repo) =>
        repo.create({
          slug: name,
          name: "Keeper",
          description: "",
          createdBy: seed.userId,
          build: {
            source: "",
            dependencies: [],
            compiled: "",
            functions: [
              {
                key: "revise",
                name: "Revise",
                description: "Revise a draft.",
                modelName: `custom_${name}__revise`,
                parametersSchema: { type: "object", properties: { ref: { type: "string" } } },
              },
            ],
          },
        }),
      );
      const conversation = yield* ChatRepo.use((repo) =>
        repo.createConversation({ userId: seed.userId, modelId: textModelId }),
      );
      return {
        seed,
        conversationId: conversation.id,
        tool: created.functions[0]!.modelName,
        toolId: created.id,
      };
    });
    // Creates "0", then each revision stores the previous value plus one.
    const keeperRun: typeof customToolRun = (input) =>
      Effect.gen(function* () {
        const ref = (input.args as { ref?: string }).ref;
        const source = ref ? yield* input.resolveFile!(ref) : null;
        if (source && source.ref.kind !== "working")
          throw new Error("Expected a working revision.");
        return {
          ok: true,
          output: "Draft saved.",
          logs: [],
          durationMs: 1,
          files: [
            {
              name: "notes.txt",
              mediaType: "text/plain",
              delivery: "working" as const,
              showModel: false,
              ...(source?.ref.kind === "working" ? { replaces: source.ref } : {}),
              bytes: Buffer.from(source ? String(Number(Buffer.from(source.bytes)) + 1) : "0"),
            },
          ],
        } satisfies CustomToolRunResult;
      }).pipe(Effect.orDie);
    const answer = (userId: string, conversationId: string, content: string) =>
      Effect.gen(function* () {
        const { assistantMessageId } = yield* ChatService.use((service) =>
          service.sendMessage({
            userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        );
        yield* Effect.flatMap(StreamEngine, (engine) =>
          Stream.runCollect(engine.subscribe(assistantMessageId, 0)),
        );
        return assistantMessageId;
      });
    const keptRows = (conversationId: string) =>
      Effect.flatMap(Db, (db) =>
        db
          .select()
          .from(conversationWorkingFiles)
          .where(eq(conversationWorkingFiles.conversationId, conversationId)),
      ).pipe(Effect.orDie);
    const userAttachments = (userId: string) =>
      Effect.flatMap(Db, (db) =>
        db
          .select({ id: attachments.id, sha256: attachmentBlobs.sha256 })
          .from(attachments)
          .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
          .where(eq(attachments.userId, userId)),
      ).pipe(Effect.orDie);
    const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");
    const refIn = (input: { prompt: unknown }) =>
      JSON.stringify(input.prompt)
        .match(/working:[a-f\d-]+@\d+/g)
        ?.at(-1);
    // One answer that creates the draft and revises it twice, publishing nothing.
    const draftTwice = (tool: string) => {
      let round = 0;
      authoringScript = (input) => {
        round += 1;
        if (round === 1) return authoringTool(input, tool, {});
        if (round <= 3) return authoringTool(input, tool, { ref: refIn(input) });
        return reply();
      };
    };

    const stoppedDraft = (userId: string, conversationId: string, tool: string) =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        customToolRun = (input) =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 2) {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(release);
            }
            return yield* keeperRun!(input);
          });
        draftTwice(tool);
        return yield* Effect.gen(function* () {
          const service = yield* ChatService;
          const { assistantMessageId } = yield* service.sendMessage({
            userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content: "Draft notes.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          });
          yield* Deferred.await(reached);
          // Turn rows share a timestamp. Stop the accepted answer, not a guessed latest row.
          const assistant = yield* ChatRepo.use((repo) => repo.getMessage(assistantMessageId));
          const { stopped } = yield* service.stopGeneration({
            userId,
            conversationId,
            messageId: assistantMessageId,
            generationId: assistant!.generationId!,
          });
          expect(stopped).toBe(true);
          yield* Effect.flatMap(StreamEngine, (engine) =>
            Stream.runCollect(engine.subscribe(assistantMessageId, 0)),
          );
          return assistantMessageId;
        }).pipe(Effect.ensuring(Deferred.interrupt(release)));
      });

    const retry = (userId: string, conversationId: string, messageId: string) =>
      Effect.gen(function* () {
        yield* ChatService.use((service) =>
          service.retryMessage({ userId, conversationId, messageId }),
        );
        yield* Effect.flatMap(StreamEngine, (engine) =>
          Stream.runCollect(engine.subscribe(messageId, 0)),
        );
      });
    /** Runs one answer whose first model call is recorded, then replies. */
    const promptOf = async (userId: string, conversationId: string) => {
      let first: GatewayInput | undefined;
      authoringScript = (input) => {
        first ??= input;
        return reply();
      };
      await runtime.runPromise(answer(userId, conversationId, "What is kept?"));
      return first!;
    };

    it("keeps the latest revision for the next answer; retrying the answer that published it brings it back", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        draftTwice(tool);
        const first = await runtime.runPromise(answer(seed.userId, conversationId, "Draft notes."));
        const [kept, ...others] = await runtime.runPromise(keptRows(conversationId));
        expect(others).toEqual([]);
        expect(kept).toMatchObject({ revision: 3, name: "notes.txt", messageId: first });
        // Earlier revisions left nothing behind: one attachment, holding "2".
        const stored = await runtime.runPromise(userAttachments(seed.userId));
        expect(stored.map((row) => row.id)).toEqual([kept!.attachmentId]);
        expect(stored[0]!.sha256).toBe(sha256Of("2"));

        let round = 0;
        let notice = "";
        let laterRound = "";
        authoringScript = (input) => {
          round += 1;
          if (round === 1) {
            notice = JSON.stringify(input.prompt);
            return authoringTool(input, tool, { ref: `working:${kept!.workingFileId}@3` });
          }
          if (round === 2) {
            laterRound = JSON.stringify(input.prompt);
            return authoringTool(input, "publish_file", { ref: refIn(input) });
          }
          return reply();
        };
        const second = await runtime.runPromise(
          answer(seed.userId, conversationId, "Finish and deliver the notes."),
        );
        // A reference, then the name quoted as data.
        const line = `working:${kept!.workingFileId}@3 \\"notes.txt\\"`;
        expect(notice).toContain(line);
        // Fixed for the whole answer, so the cached prefix holds: the next round
        // still reads @3 though the draft is at revision 4 by then.
        expect(laterRound).toContain(`working:${kept!.workingFileId}@4`);
        expect(laterRound.indexOf(line)).toBe(notice.indexOf(line));
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        expect(detail.toolCalls.find((row) => row.toolName === "publish_file")?.status).toBe(
          "complete",
        );
        const published = detail.attachments.filter((row) => row.messageId === second);
        expect(published).toHaveLength(1);
        // Delivered, so no longer offered; the first answer's copy stays for a retry.
        expect(detail.workingFiles).toEqual([]);
        expect(
          (await runtime.runPromise(keptRows(conversationId))).map((row) => [
            row.messageId,
            row.attachmentId,
          ]),
        ).toEqual(
          expect.arrayContaining([
            [first, kept!.attachmentId],
            [second, null],
          ]),
        );

        await runtime.runPromise(retry(seed.userId, conversationId, second));
        expect(
          (await runtime.runPromise(keptRows(conversationId))).map((row) => row.messageId),
        ).toEqual([first]);
        // The retried answer's delivery went with it; the draft it consumed is back.
        const remaining = await runtime.runPromise(userAttachments(seed.userId));
        expect(remaining.map((row) => row.id)).toEqual([kept!.attachmentId]);
        expect(JSON.stringify((await promptOf(seed.userId, conversationId)).prompt)).toContain(
          line,
        );
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("restores the revision an answer started from when that answer is retried", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        draftTwice(tool);
        const first = await runtime.runPromise(answer(seed.userId, conversationId, "Draft notes."));
        const [kept] = await runtime.runPromise(keptRows(conversationId));
        let round = 0;
        authoringScript = (input) => {
          round += 1;
          if (round === 1)
            return authoringTool(input, tool, { ref: `working:${kept!.workingFileId}@3` });
          return reply();
        };
        const second = await runtime.runPromise(
          answer(seed.userId, conversationId, "Revise the notes."),
        );
        const revised = await runtime.runPromise(keptRows(conversationId));
        expect(revised.find((row) => row.messageId === second)).toMatchObject({ revision: 4 });

        await runtime.runPromise(retry(seed.userId, conversationId, second));
        const [restored, ...others] = await runtime.runPromise(keptRows(conversationId));
        expect(others).toEqual([]);
        expect(restored).toMatchObject({ messageId: first, revision: 3 });
        const stored = await runtime.runPromise(userAttachments(seed.userId));
        expect(stored.map((row) => row.sha256)).toEqual([sha256Of("2")]);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("lets a new answer draft beside eight kept drafts", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        let round = 0;
        authoringScript = (input) => {
          round += 1;
          return round <= 8 ? authoringTool(input, tool, {}) : reply();
        };
        await runtime.runPromise(answer(seed.userId, conversationId, "Start eight drafts."));
        expect(await runtime.runPromise(keptRows(conversationId))).toHaveLength(8);
        round = 8;
        authoringScript = (input) => {
          round += 1;
          return round === 9 ? authoringTool(input, tool, {}) : reply();
        };
        const next = await runtime.runPromise(
          answer(seed.userId, conversationId, "Start one more."),
        );
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        const call = detail.toolCalls.find(
          (row) => row.messageId === next && row.toolName === tool,
        );
        expect(call?.status).toBe("complete");
        expect(await runtime.runPromise(keptRows(conversationId))).toHaveLength(9);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("reads a kept workbook back as the spreadsheet editor's, never as a deck", async () => {
      const { seed, conversationId } = await runtime.runPromise(keptSetup);
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const turn = yield* repo.insertMessage({
            conversationId,
            role: "assistant",
            status: "complete",
          });
          const book = yield* AttachmentService.use((service) =>
            service.upload({
              userId: seed.userId,
              fileName: "budget.xlsx",
              declaredMediaType: "application/octet-stream",
              bytes: Buffer.from("book"),
            }),
          );
          yield* Effect.flatMap(Db, (db) =>
            db.insert(conversationWorkingFiles).values({
              workingFileId: uuidv7(),
              messageId: turn.id,
              conversationId,
              attachmentId: book.id,
              name: "budget.xlsx",
              mediaType: book.mediaType,
              owner: "spreadsheet",
              revision: 1,
              fingerprint: sha256Of("book"),
            }),
          );
          return turn.id;
        }).pipe(Effect.orDie),
      );
      const kept = await runtime.runPromise(
        KeptWorkingFiles.use((files) => files.list(conversationId)),
      );
      expect(kept).toEqual([
        expect.objectContaining({ name: "budget.xlsx", owner: "spreadsheet" }),
      ]);
      expect(first).toBeTruthy();
    });

    it("offers kept drafts only to the editor that made them", async () => {
      const { seed, conversationId, tool, toolId } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        draftTwice(tool);
        const first = await runtime.runPromise(answer(seed.userId, conversationId, "Draft notes."));
        const [custom] = await runtime.runPromise(keptRows(conversationId));
        // A deck an earlier answer left while presentations were offered.
        const deckId = uuidv7();
        await runtime.runPromise(
          Effect.gen(function* () {
            const deck = yield* AttachmentService.use((service) =>
              service.upload({
                userId: seed.userId,
                fileName: "deck.pptx",
                declaredMediaType: "application/octet-stream",
                bytes: Buffer.from("deck"),
              }),
            );
            yield* Effect.flatMap(Db, (db) =>
              db.insert(conversationWorkingFiles).values({
                workingFileId: deckId,
                messageId: first,
                conversationId,
                attachmentId: deck.id,
                name: "deck.pptx",
                mediaType: deck.mediaType,
                owner: "presentation",
                revision: 2,
                fingerprint: sha256Of("deck"),
              }),
            );
          }).pipe(Effect.orDie),
        );
        const offered = await promptOf(seed.userId, conversationId);
        const text = JSON.stringify(offered.prompt);
        expect(text).toContain(`working:${custom!.workingFileId}@3`);
        // No presentation tools here, so their draft is not advertised.
        expect(text).not.toContain(deckId);
        expect(Object.keys(offered.toolkit?.tools ?? {})).toContain("publish_file");

        // Another module's offer does not reach this module's draft.
        await runtime.runPromise(
          CustomToolRepo.use((repo) => repo.setEnabled(toolId, false)).pipe(Effect.orDie),
        );
        expect(JSON.stringify((await promptOf(seed.userId, conversationId)).prompt)).not.toContain(
          custom!.workingFileId,
        );
        // With no module offered, its kept drafts are not continued. publish_file stays,
        // since the computer's tools hand files back too.
        const enabled = await runtime.runPromise(
          CustomToolRepo.use((repo) => repo.list()).pipe(
            Effect.map((rows) => rows.filter((row) => row.enabled).map((row) => row.id)),
          ),
        );
        const setAll = (value: boolean) =>
          runtime.runPromise(
            Effect.forEach(enabled, (id) =>
              CustomToolRepo.use((repo) => repo.setEnabled(id, value)).pipe(Effect.orDie),
            ),
          );
        await setAll(false);
        try {
          const without = await promptOf(seed.userId, conversationId);
          expect(JSON.stringify(without.prompt)).not.toContain("Unpublished working files kept");
        } finally {
          await setAll(true);
        }
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("keeps each round's revision before the next model call", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      let calls = 0;
      let duringSecondCall: ReadonlyArray<{ revision: number }> = [];
      customToolRun = (input) =>
        Effect.gen(function* () {
          calls += 1;
          // Written at the round boundary, so a crash here would still leave round one.
          if (calls === 2)
            duringSecondCall = yield* Effect.promise(() =>
              runtime.runPromise(keptRows(conversationId)),
            );
          return yield* keeperRun!(input);
        });
      try {
        draftTwice(tool);
        const answered = await runtime.runPromise(
          answer(seed.userId, conversationId, "Draft notes."),
        );
        expect(duringSecondCall.map((row) => row.revision)).toEqual([1]);
        // One row per answer: later boundaries replace it rather than add rows.
        const rows = await runtime.runPromise(keptRows(conversationId));
        expect(rows.map((row) => [row.messageId, row.revision])).toEqual([[answered, 3]]);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("keeps what a stopped answer drafted", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      try {
        const stopped = await runtime.runPromise(stoppedDraft(seed.userId, conversationId, tool));
        expect(
          (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(stopped))))?.status,
        ).toBe("aborted");
        const [kept, ...others] = await runtime.runPromise(keptRows(conversationId));
        expect(others).toEqual([]);
        // Stop interrupts the second call before it can create a new revision.
        expect(kept?.messageId).toBe(stopped);
        expect(kept?.revision).toBe(1);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("stops a running answer on a delete, so Undo brings back a stopped one", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      let calls = 0;
      let deleting: Fiber.Fiber<string | null, unknown> | undefined;
      customToolRun = (input) =>
        Effect.gen(function* () {
          calls += 1;
          // The second call is where the person deletes the chat. Forked: the
          // delete waits for this very answer to settle.
          if (calls === 2)
            deleting = runtime.runFork(
              ChatService.use((service) =>
                service.deleteConversation({ userId: seed.userId, conversationId }),
              ),
            );
          return yield* keeperRun!(input);
        });
      try {
        draftTwice(tool);
        const stopped = await runtime.runPromise(
          answer(seed.userId, conversationId, "Draft notes."),
        );
        const mark = await runtime.runPromise(Fiber.join(deleting!));
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const repo = yield* ChatRepo;
            const service = yield* ChatService;
            const hidden = yield* repo.getConversation(seed.userId, conversationId).pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            );
            const restored = yield* service.restoreConversation({
              userId: seed.userId,
              conversationId,
              mark: mark!,
            });
            const detail = yield* loadConversationDetail(seed.userId, conversationId);
            return {
              hidden,
              restored,
              status: (yield* repo.getMessage(stopped))?.status,
              shown: detail.messages.some((message) => message.id === stopped),
            };
          }),
        );
        expect(result).toEqual({
          hidden: "ConversationNotFound",
          restored: true,
          status: "aborted",
          shown: true,
        });
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("continues a stopped answer's draft from its last kept revision", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      try {
        const stopped = await runtime.runPromise(stoppedDraft(seed.userId, conversationId, tool));
        expect(
          (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(stopped))))?.status,
        ).toBe("aborted");
        const [kept] = await runtime.runPromise(keptRows(conversationId));
        expect(kept?.messageId).toBe(stopped);
        expect(kept?.revision).toBe(1);
        customToolRun = keeperRun;
        let round = 0;
        let notice = "";
        authoringScript = (input) => {
          round += 1;
          if (round === 1) {
            notice = JSON.stringify(input.prompt);
            return authoringTool(input, tool, { ref: refIn(input) });
          }
          return reply();
        };
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* ChatService.use((service) =>
              service.resumeMessage({ userId: seed.userId, conversationId, messageId: stopped }),
            );
            yield* Effect.flatMap(StreamEngine, (engine) =>
              Stream.runCollect(engine.subscribe(stopped, 0)),
            );
          }),
        );
        expect(notice).toContain(`working:${kept!.workingFileId}@${kept!.revision}`);
        expect(notice).toContain("this answer before it was interrupted");
        // The same answer keeps the same row, one revision further on.
        const after = await runtime.runPromise(keptRows(conversationId));
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ messageId: stopped, revision: kept!.revision + 1 });
        expect(
          (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(stopped))))?.status,
        ).toBe("complete");
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("keeps nothing for an attempt that no longer owns its answer", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        draftTwice(tool);
        const first = await runtime.runPromise(answer(seed.userId, conversationId, "Draft notes."));
        const before = await runtime.runPromise(keptRows(conversationId));
        const attachmentsBefore = await runtime.runPromise(userAttachments(seed.userId));
        // The answer has settled, as after a Stop or a retry that superseded it.
        const exit = await runtime.runPromise(
          KeptWorkingFiles.use((kept) =>
            kept.keep(
              {
                userId: seed.userId,
                conversationId,
                messageId: first,
                generationId: uuidv7(),
              },
              {
                ref: { kind: "working", id: before[0]!.workingFileId, revision: 9 },
                name: "notes.txt",
                mediaType: "text/plain",
                bytes: Buffer.from("late"),
                fingerprint: sha256Of("late"),
                owner: before[0]!.customToolId
                  ? `custom:${before[0]!.customToolId}`
                  : "presentation",
              },
            ),
          ).pipe(Effect.exit),
        );
        expect(exit._tag).toBe("Failure");
        expect(await runtime.runPromise(keptRows(conversationId))).toEqual(before);
        expect(await runtime.runPromise(userAttachments(seed.userId))).toEqual(attachmentsBefore);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);

    it("marks a deck edit while its arguments are written, even one that never completes", async () => {
      const { seed, conversationId } = await runtime.runPromise(keptSetup);
      authoringScript = () =>
        Stream.make(
          AiResponse.makePart("tool-params-start", {
            id: "deck-call",
            name: "edit_presentation",
            providerExecuted: false,
          }),
          AiResponse.makePart("tool-params-end", { id: "deck-call" }),
          AiResponse.makePart("text-delta", { id: "t", delta: "Never mind." }),
          authoringFinish(),
        );
      try {
        const id = await runtime.runPromise(answer(seed.userId, conversationId, "Build a deck."));
        const chunks = await runtime.runPromise(ChatRepo.use((repo) => repo.chunksAfter(id, 0)));
        const writing = chunks.filter((chunk) => chunk.kind === "writing");
        expect(writing).toHaveLength(1);
        expect(JSON.parse(writing[0]!.delta)).toMatchObject({
          v: 1,
          id: "deck-call",
          name: "edit_presentation",
          textOffset: 0,
          turnIndex: 0,
          generationId: expect.any(String),
        });
        // A marker, not content: the answer is only what was written as text.
        expect(
          (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(id))))?.content,
        ).toBe("Never mind.");
      } finally {
        authoringScript = null;
      }
    }, 60_000);

    it("drops a kept draft with the answer that is retried, and with the deleted chat", async () => {
      const { seed, conversationId, tool } = await runtime.runPromise(keptSetup);
      customToolRun = keeperRun;
      try {
        draftTwice(tool);
        const first = await runtime.runPromise(answer(seed.userId, conversationId, "Draft notes."));
        expect(await runtime.runPromise(keptRows(conversationId))).toHaveLength(1);
        const detail = await runtime.runPromise(
          loadConversationDetail(seed.userId, conversationId),
        );
        // Named for the rewind confirmation, like documents.
        expect(detail.workingFiles).toEqual([
          expect.objectContaining({ name: "notes.txt", messageId: first }),
        ]);

        authoringScript = () => reply();
        await runtime.runPromise(
          ChatService.use((service) =>
            service.retryMessage({ userId: seed.userId, conversationId, messageId: first }),
          ),
        );
        await runtime.runPromise(
          Effect.flatMap(StreamEngine, (engine) => Stream.runCollect(engine.subscribe(first, 0))),
        );
        expect(await runtime.runPromise(keptRows(conversationId))).toEqual([]);
        expect(await runtime.runPromise(userAttachments(seed.userId))).toEqual([]);

        draftTwice(tool);
        await runtime.runPromise(answer(seed.userId, conversationId, "Draft them again."));
        expect(await runtime.runPromise(keptRows(conversationId))).toHaveLength(1);
        await runtime.runPromise(
          ChatService.use((service) =>
            service
              .deleteConversation({ userId: seed.userId, conversationId })
              .pipe(
                Effect.andThen(outlastGrace(conversationId)),
                Effect.andThen(service.sweepExpired()),
              ),
          ),
        );
        // Purging the chat releases the kept copy with it, not at the kept-file sweep.
        expect(await runtime.runPromise(userAttachments(seed.userId))).toEqual([]);
      } finally {
        authoringScript = null;
        customToolRun = null;
      }
    }, 60_000);
  });
});

describe("desktop calls run by the sending app", () => {
  // A fresh chat: the seed's own answer is still streaming, which would hold every send.
  const desktopChat = Effect.gen(function* () {
    const seed = yield* setupConversation;
    const conversation = yield* (yield* ChatRepo).createConversation({
      userId: seed.userId,
      modelId: textModelId,
    });
    return { ...seed, conversation };
  });

  const send = (seed: Effect.Success<typeof desktopChat>, browser = false) =>
    Effect.flatMap(ChatService, (service) =>
      service.sendMessage({
        userId: seed.userId,
        conversation: { kind: "existing", id: seed.conversation.id },
        modelId: textModelId,
        content: "What is in the readme?",
        searchEnabled: false,
        researchEnabled: false,
        attachmentIds: [],
        desktop: { executorId: "desktop-test-session", browser },
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
    /** What the server decided about the call, as the page receives it. */
    readonly meta?: ExternalOperation["meta"];
    /** The arguments the page runs with, which the start chunk may show redacted. */
    readonly operationArgs?: Record<string, unknown> | undefined;
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
              const owned = yield* external.inspect(envelope.callId);
              const call = {
                name: envelope.name,
                args: { ...envelope.args },
                meta: owned?.meta,
                ...(envelope.name.startsWith("browser_") ? { operationArgs: owned?.args } : {}),
              };
              seen.push(call);
              yield* Deferred.succeed(first, call);
              const reply = answer(call);
              if (reply !== null) {
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

  it("keeps the computer's state out of the cached system prompt, in each answer's opening", async () => {
    const seed = await runtime.runPromise(desktopChat);
    await runtime.runPromise(
      Effect.flatMap(ComputerRepo, (repo) =>
        repo.saveMachine(seed.userId, {
          machineId: "laptop",
          name: "Laptop",
          platform: "darwin",
          computer: { status: "ready" },
          remote: true,
        }),
      ),
    );
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    const sendAndWait = (content: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* ChatService;
          const sent = yield* service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          });
          const engine = yield* StreamEngine;
          yield* Stream.runDrain(engine.subscribe(sent.assistantMessageId, 0));
        }),
      );
    try {
      await sendAndWait("Hello");
      // Between turns the chat binds to a machine that is not connected, with a folder.
      await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .update(conversations)
            .set({ machineId: "laptop", computerFolders: [{ name: "site", readOnly: false }] })
            .where(eq(conversations.id, seed.conversation.id)),
        ),
      );
      await sendAndWait("And now?");
      const text = (message: { content: unknown }) => JSON.stringify(message.content);
      const system = (input: GatewayInput) =>
        input.prompt.content.filter((message) => message.role === "system").map(text);
      expect(system(prompts[1]!)).toEqual(system(prompts[0]!));
      expect(system(prompts[0]!).join()).not.toContain("Laptop");
      const notices = (input: GatewayInput) =>
        input.prompt.content
          .filter((message) => message.role === "user")
          .map(text)
          .filter((content) => content.includes("This chat's computer, as of this answer"));
      expect(notices(prompts[0]!).join()).toContain("none yet");
      const latest = notices(prompts[1]!).at(-1)!;
      expect(latest).toContain('\\"Laptop\\", offline right now');
      expect(latest).toContain("/folders/site");
    } finally {
      authoringScript = null;
    }
  });

  it("asks the sending machine for a new chat's folders, and the first folders bind the chat", async () => {
    const seed = await runtime.runPromise(desktopChat);
    authoringScript = () =>
      Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const hub = yield* MachineHub;
          const repo = yield* ComputerRepo;
          const hello = {
            machineId: "laptop",
            name: "Laptop",
            platform: "darwin" as const,
            computer: { status: "ready" as const },
            remote: true,
          };
          yield* repo.saveMachine(seed.userId, hello);
          const events = yield* hub.connect(seed.userId, hello, "laptop-session");
          // The folder was picked before the chat existed, under the id the composer holds.
          const id = uuidv7();
          const sent = yield* (yield* ChatService).sendMessage({
            userId: seed.userId,
            conversation: { kind: "new", id },
            modelId: textModelId,
            content: "Look at my site",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            deviceSessionId: "laptop-session",
          });
          const [asked] = yield* Stream.filter(events, (event) => event.type === "folders").pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          const bound = yield* repo.setFolders(seed.userId, "laptop", id, [
            { name: "site", readOnly: false },
          ]);
          const takenOver = yield* repo.setFolders(seed.userId, "desk", id, [
            { name: "other", readOnly: false },
          ]);
          const chat = yield* repo.chat(seed.userId, id);
          yield* Stream.runDrain((yield* StreamEngine).subscribe(sent.assistantMessageId, 0));
          return { asked, id, bound, takenOver, chat };
        }).pipe(Effect.scoped),
      );
      expect(result.asked).toEqual({ type: "folders", conversationId: result.id });
      expect(result.bound).toBe(true);
      expect(result.takenOver).toBe(false);
      expect(result.chat).toMatchObject({
        machineId: "laptop",
        folders: [{ name: "site", readOnly: false }],
      });
    } finally {
      authoringScript = null;
    }
  });

  it("runs a queued message's calls as sent from the machine that queued it", async () => {
    const seed = await runtime.runPromise(desktopChat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      // The first answer settles the chat, so the queue may move; the queued one lists.
      if (round === 2) return authoringTool(input, "list_folder", { path: "." });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    try {
      const delivered = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* (yield* ComputerRepo).saveMachine(seed.userId, {
            machineId: "laptop",
            name: "Laptop",
            platform: "darwin",
            computer: { status: "ready" },
            remote: false,
          });
          yield* db
            .update(conversations)
            .set({ machineId: "laptop", permissionLevel: "allow" })
            .where(eq(conversations.id, seed.conversation.id));
          const engine = yield* StreamEngine;
          const first = yield* (yield* ChatService).sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: textModelId,
            content: "Hello",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          });
          yield* Stream.runDrain(engine.subscribe(first.assistantMessageId, 0));
          // Remote use is off: only the machine's own session may run its calls.
          const events = yield* (yield* MachineHub).connect(
            seed.userId,
            {
              machineId: "laptop",
              name: "Laptop",
              platform: "darwin",
              computer: { status: "ready" },
              remote: false,
            },
            "laptop-session",
          );
          // The chat is idle, so the server starts the entry itself, with no request to ask.
          yield* (yield* ChatService).queueMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            content: "What is in the workspace?",
            attachmentIds: [],
            input: { modelId: textModelId, searchEnabled: false, researchEnabled: false },
            senderSessionId: "laptop-session",
          });
          const [event] = yield* Stream.filter(events, (next) => next.type === "call").pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          if (event?.type !== "call") throw new Error("no call reached the machine");
          yield* (yield* ExternalCompletion).complete(event.callId, {
            v: 1,
            ok: true,
            summary: "Listed .",
            detail: "/workspace/",
            truncated: false,
          });
          // The queued message's answer: the newest one.
          const answers = yield* db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, seed.conversation.id),
                eq(messages.role, "assistant"),
              ),
            )
            .orderBy(messages.createdAt);
          expect(answers).toHaveLength(2);
          yield* Stream.runDrain(engine.subscribe(answers.at(-1)!.id, 0));
          return event;
        }).pipe(Effect.scoped),
      );
      expect(delivered).toMatchObject({ type: "call", name: "list_folder" });
    } finally {
      authoringScript = null;
    }
  });

  it("offers the browser only to an app that can drive one, vouching for the user's own addresses", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const offered: string[][] = [];
    const prompts: GatewayInput[] = [];
    authoringScript = (input) => {
      prompts.push(input);
      offered.push(Object.keys(input.toolkit?.tools ?? {}));
      const round = prompts.length;
      if (round === 2)
        return authoringTool(input, "browser_open", { url: "https://example.com/docs" });
      if (round === 3)
        return authoringTool(input, "browser_open", { url: "https://elsewhere.test/" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Done." }),
        authoringFinish(),
      );
    };
    const sendWith = (content: string, desktopBrowser: boolean) =>
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
            desktop: { executorId: "desktop-test-session", browser: desktopBrowser },
          }),
        ),
      );
    const opened = {
      v: 1,
      ok: true,
      summary: "Opened example.com in t1",
      detail: "t1",
      truncated: false,
    };
    try {
      const without = await sendWith("Hello", false);
      await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          Stream.runDrain(engine.subscribe(without.assistantMessageId, 0)),
        ),
      );
      const sent = await sendWith("Open https://example.com/docs please", true);
      const seen = await runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(sent.assistantMessageId, () => opened);
          yield* Fiber.join(bridge.fiber);
          return bridge.seen;
        }),
      );
      expect(offered[0]).not.toContain("browser_open");
      expect(offered[1]).toEqual(expect.arrayContaining(["browser_open", "browser_snapshot"]));
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("web browser on the user's computer");
      expect(seen.map((call) => [call.args.url, call.meta?.preauthorized])).toEqual([
        ["https://example.com/docs", true],
        // An address the model came up with asks first.
        ["https://elsewhere.test/", false],
      ]);
      expect(seen[0]?.meta?.temporary).toBe(false);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("hands typed text to the page alone, never to the row or the chunks, flag or not", async () => {
    const seed = await runtime.runPromise(desktopChat);
    let round = 0;
    authoringScript = (input) => {
      round++;
      // No `sensitive`: a model that forgets it must not leak the password either.
      if (round === 1)
        return authoringTool(input, "browser_type", {
          tab: "t1",
          ref: "e2",
          text: "hunter2",
        });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Signed in." }),
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
            content: "Sign me in with hunter2",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            desktop: { executorId: "desktop-test-session", browser: true },
          }),
        ),
      );
      const outcome = await runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(sent.assistantMessageId, () => ({
            v: 1,
            ok: true,
            summary: "Typed a secret into e2 in t1",
            detail: "t1",
            truncated: false,
          }));
          yield* Fiber.join(bridge.fiber);
          const rows = yield* (yield* Db)
            .select({ args: messageToolCalls.arguments })
            .from(messageToolCalls)
            .where(eq(messageToolCalls.messageId, sent.assistantMessageId));
          return { seen: bridge.seen, rows };
        }),
      );
      expect(outcome.seen[0]?.operationArgs?.text).toBe("hunter2");
      expect(outcome.seen[0]?.args).toEqual({ tab: "t1", ref: "e2" });
      expect(JSON.stringify(outcome.rows)).not.toContain("hunter2");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("shares a screenshot only when the model asks to", async () => {
    const seed = await runtime.runPromise(desktopChat);
    const png = generatedPng.toString("base64");
    // Answer one only looks; answer two shows the user what it sees. Decided
    // from the prompt, since side generations (a title) call the model too.
    authoringScript = (input) => {
      const prompt = JSON.stringify(input.prompt);
      const showing = prompt.includes("Show me the page");
      const done = showing
        ? prompt.includes("shared with the user")
        : prompt.includes("Screenshot working:");
      if (input.toolkit?.tools?.browser_snapshot && !done)
        return authoringTool(input, "browser_snapshot", {
          tab: "t1",
          screenshot: true,
          ...(showing ? { share: true } : {}),
        });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Here it is." }),
        authoringFinish(),
      );
    };
    const sendPrompt = (content: string) =>
      runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: visionModelId,
            content,
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
            desktop: { executorId: "desktop-test-session", browser: true },
          }),
        ),
      );
    const answered = (messageId: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const bridge = yield* fakeBridge(messageId, () => ({
            v: 1,
            ok: true,
            summary: "Read Example",
            detail: "t1: Example",
            truncated: false,
            file: { mediaType: "image/png", base64: png, name: "a.test screenshot.png" },
          }));
          yield* Fiber.join(bridge.fiber);
          return yield* loadConversationDetail(seed.userId, seed.conversation.id);
        }),
      );
    try {
      const looked = await sendPrompt("Look at the page");
      const first = await answered(looked.assistantMessageId);
      expect(
        first.attachments.filter((row) => row.messageId === looked.assistantMessageId),
      ).toEqual([]);
      // Never kept for a later answer either: the page changes, so it takes another.
      expect(first.workingFiles).toEqual([]);

      const shown = await sendPrompt("Show me the page");
      const second = await answered(shown.assistantMessageId);
      expect(
        second.attachments
          .filter((row) => row.messageId === shown.assistantMessageId)
          .map((row) => row.mediaType),
      ).toEqual(["image/png"]);
      // The model is told, in the row a reload shows too, that the user sees it.
      expect(
        JSON.stringify(
          second.toolCalls.filter(
            (row) =>
              row.messageId === shown.assistantMessageId && row.toolName === "browser_snapshot",
          ),
        ),
      ).toContain("shared with the user");
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("leaves the row terminal when the generation is stopped mid-wait, and drops a late answer", async () => {
    const seed = await runtime.runPromise(desktopChat);
    authoringScript = (input) =>
      authoringTool(input, "browser_open", { url: "https://example.com/" });
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
              summary: "Opened example.com",
              detail: "LATE_ANSWER",
              truncated: false,
            }),
          };
        }),
      );

      expect(result.waited).toMatchObject({
        name: "browser_open",
        args: { url: "https://example.com/" },
      });
      expect(result.stopped).toBe(true);
      expect(result.late).toBe(false);
      const call = result.detail.toolCalls.at(-1)!;
      expect(call.toolName).toBe("browser_open");
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
    authoringScript = (input) =>
      authoringTool(input, "browser_open", { url: "https://example.com/" });
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
      return authoringTool(input, "browser_open", { url: "https://example.com/" });
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
              const conversation = yield* (yield* ChatRepo).createConversation({
                userId,
                modelId: textModelId,
              });
              const sent = yield* service.sendMessage({
                userId,
                conversation: { kind: "existing", id: conversation.id },
                modelId: textModelId,
                content: "Write the note.",
                searchEnabled: false,
                researchEnabled: false,
                attachmentIds: [],
                desktop: { executorId: "executor-1", browser: true },
                deviceSessionId,
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
      expect(call.toolName).toBe("browser_open");
      expect(call.status).toBe("error");
      expect(JSON.stringify(call.result)).toContain("may be closed");
      const message = outcome.detail.messages.at(-1)!;
      expect(message.status).toBe("complete");
      expect(message.content).toBe("Your desktop app closed.");
    } finally {
      authoringScript = null;
    }
  }, 60_000);
});

describe("resuming an interrupted answer", () => {
  const settle = (messageId: string) =>
    Effect.flatMap(StreamEngine, (engine) => Stream.runCollect(engine.subscribe(messageId, 0)));
  const resume = (userId: string, conversationId: string, messageId: string, modelId?: string) =>
    Effect.gen(function* () {
      yield* ChatService.use((service) =>
        service.resumeMessage({
          userId,
          conversationId,
          messageId,
          ...(modelId ? { modelId } : {}),
        }),
      );
      yield* settle(messageId);
    });
  const text = (delta: string) => ({ type: "text-delta", id: "t", delta }) as ChatStreamPart;
  const says = (delta: string) =>
    Stream.make(text(delta), {
      type: "finish",
      reason: "stop",
      usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
    } as ChatStreamPart);
  /** Text, then one native call, dispatched through the SDK like a real round. */
  const saysThenCalls = (input: GatewayInput, delta: string, name: string, params: unknown) => {
    const id = uuidv7();
    const encodePart = Schema.encodeUnknownEffect(AiResponse.StreamPart(input.toolkit!));
    return Stream.unwrap(
      LanguageModel.make({
        generateText: () => Effect.die("only streaming is used here"),
        streamText: () =>
          Stream.make(
            AiResponse.makePart("text-delta", { id: "t", delta }),
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
  const chatOf = Effect.gen(function* () {
    const seed = yield* setupConversation;
    const conversation = yield* ChatRepo.use((repo) =>
      repo.createConversation({ userId: seed.userId, modelId: textModelId }),
    );
    return { userId: seed.userId, conversationId: conversation.id };
  });
  const send = (userId: string, conversationId: string, content: string) =>
    Effect.gen(function* () {
      const { assistantMessageId } = yield* ChatService.use((service) =>
        service.sendMessage({
          userId,
          conversation: { kind: "existing", id: conversationId },
          modelId: textModelId,
          content,
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        }),
      );
      yield* settle(assistantMessageId);
      return assistantMessageId;
    });
  /** An answer a crash or provider error ended, written as rows. */
  const failedAnswer = (content: string) =>
    Effect.gen(function* () {
      const seed = yield* setupConversation;
      const db = yield* Db;
      yield* db
        .insert(messageChunks)
        .values({ messageId: seed.assistant.id, seq: 1, kind: "text", delta: content });
      yield* db
        .update(messages)
        .set({
          status: "error",
          content,
          modelId: textModelId,
          error: { tag: "GenerationFailed", message: "provider exploded" },
          completedAt: new Date(),
        })
        .where(eq(messages.id, seed.assistant.id));
      return seed;
    });
  const contiguous = (chunks: ReadonlyArray<{ seq: number }>) =>
    chunks.map((chunk) => chunk.seq).every((seq, index) => seq === index + 1);

  it("continues a failed answer from its text and rounds, one ledger row per attempt", async () => {
    const { userId, conversationId } = await runtime.runPromise(chatOf);
    let round = 0;
    let resumedPrompt = "";
    authoringScript = (input) => {
      round += 1;
      if (round === 1)
        return saysThenCalls(input, "Drafting the notes. ", "create_document", {
          title: "Notes",
          content: "- one",
        });
      if (round === 2)
        return Stream.make(text("Half of the")).pipe(
          Stream.concat(Stream.die("provider exploded")),
        );
      if (round === 3) {
        resumedPrompt = JSON.stringify(input.prompt);
        return saysThenCalls(input, " answer.", "create_document", {
          title: "More notes",
          content: "- two",
        });
      }
      return says(" Done.");
    };
    try {
      const messageId = await runtime.runPromise(send(userId, conversationId, "Write notes."));
      const failed = await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(messageId)));
      expect(failed).toMatchObject({
        status: "error",
        content: "Drafting the notes. Half of the",
      });
      const before = await runtime.runPromise(
        ChatRepo.use((repo) => repo.chunksAfter(messageId, 0)),
      );

      await runtime.runPromise(resume(userId, conversationId, messageId));

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const db = yield* Db;
          return {
            message: yield* repo.getMessage(messageId),
            chunks: yield* repo.chunksAfter(messageId, 0),
            calls: yield* repo.listToolCalls([messageId]),
            ledger: yield* db
              .select()
              .from(usageEvents)
              .where(eq(usageEvents.messageId, messageId))
              .orderBy(usageEvents.createdAt),
            detail: yield* loadConversationDetail(userId, conversationId),
          };
        }),
      );
      expect(result.message).toMatchObject({
        status: "complete",
        content: "Drafting the notes. Half of the answer. Done.",
        error: null,
      });
      expect(result.message!.generationId).not.toBe(failed!.generationId);
      // The kept chunks are the start of one contiguous sequence.
      expect(result.chunks.slice(0, before.length)).toEqual(before);
      expect(contiguous(result.chunks)).toBe(true);
      expect(
        result.chunks
          .filter((chunk) => chunk.kind === "text")
          .map((chunk) => chunk.delta)
          .join(""),
      ).toBe(result.message!.content);
      // Earlier rounds stay; the new one continues the turn space after them.
      expect(result.calls.map((call) => [call.toolName, call.turnIndex])).toEqual([
        ["create_document", 0],
        ["create_document", 1],
      ]);
      expect(result.calls[1]!.textOffset).toBe("Drafting the notes. Half of the answer.".length);
      expect(result.detail.documents.map((document) => document.title).toSorted()).toEqual([
        "More notes",
        "Notes",
      ]);
      // The model read its own earlier work as text and records, never as
      // replayed native calls, then the one-time reminder.
      expect(resumedPrompt).toContain("Drafting the notes. ");
      expect(resumedPrompt).toContain("<application-record>");
      expect(resumedPrompt).toContain("- create_document: completed.");
      expect(resumedPrompt).toContain("Half of the");
      expect(resumedPrompt).toContain(RESUME_REMINDER);
      expect(resumedPrompt).not.toContain('"type":"tool-call"');
      expect(result.ledger.map((row) => row.inputTokens)).toEqual([100, 200]);
      expect(result.message!.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("continues a stopped answer after its last word", async () => {
    const { userId, conversationId } = await runtime.runPromise(chatOf);
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    hold = { after: 2, reached, release };
    try {
      const sent = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: textModelId,
            content: "Count.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      const messageId = sent.assistantMessageId;
      await runtime.runPromise(Deferred.await(reached));
      const generationId = (await runtime.runPromise(ChatRepo.use((r) => r.getMessage(messageId))))!
        .generationId!;
      await runtime.runPromise(
        ChatService.use((service) =>
          service.stopGeneration({ userId, conversationId, messageId, generationId }),
        ),
      );
      await runtime.runPromise(settle(messageId));
      hold = null;
      await runtime.runPromise(Deferred.interrupt(release));
      const stopped = await runtime.runPromise(ChatRepo.use((r) => r.getMessage(messageId)));
      expect(stopped?.status).toBe("aborted");
      // Whatever was written before the stop, and only a part of the answer.
      const partial = stopped!.content;
      expect(partial).not.toBe("");
      expect("alpha beta gamma delta epsilon".startsWith(partial)).toBe(true);

      const calls = streamPrompts.length;
      await runtime.runPromise(resume(userId, conversationId, messageId));
      const final = await runtime.runPromise(ChatRepo.use((r) => r.getMessage(messageId)));
      expect(final).toMatchObject({
        status: "complete",
        content: `${partial}alpha beta gamma delta epsilon`,
      });
      const prompt = streamPrompts[calls]!;
      const messagesSent = prompt.content;
      // The partial text is the model's own turn, then the reminder follows it.
      expect(messagesSent.at(-2)).toMatchObject({ role: "assistant" });
      expect(JSON.stringify(messagesSent.at(-2))).toContain(partial);
      expect(JSON.stringify(messagesSent.at(-1))).toContain(RESUME_REMINDER);
      const chunks = await runtime.runPromise(ChatRepo.use((r) => r.chunksAfter(messageId, 0)));
      expect(contiguous(chunks)).toBe(true);
    } finally {
      hold = null;
    }
  }, 60_000);

  it("resumes a reaped crash with its steers in place, retargets a queued steer and keeps a late research row", async () => {
    const seed = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* setupConversation;
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const content = "Checking the machine. ";
        yield* db
          .insert(messageChunks)
          .values({ messageId: seeded.assistant.id, seq: 1, kind: "text", delta: content });
        yield* repo.insertToolCall({
          id: uuidv7(),
          messageId: seeded.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          textOffset: content.length,
          providerCallId: "command-1",
          toolName: "run_command",
          family: "desktop",
          arguments: { command: "ls" },
        });
        const researchRow = uuidv7();
        yield* repo.insertToolCall({
          id: researchRow,
          messageId: seeded.assistant.id,
          turnIndex: 0,
          callIndex: 1,
          textOffset: content.length,
          providerCallId: "research-1",
          toolName: "deep_research",
          family: "research",
          arguments: {},
        });
        // A steer the crashed attempt took in after its first round.
        const steer = yield* repo.insertMessage({
          conversationId: seeded.conversation.id,
          role: "user",
          content: "use the staging box",
        });
        yield* db
          .update(messages)
          .set({
            steeredIntoMessageId: seeded.assistant.id,
            steerTurnIndex: 0,
            steerTextOffset: content.length,
          })
          .where(eq(messages.id, steer.id));
        const entryId = uuidv7();
        yield* db.insert(conversationQueueEntries).values({
          id: entryId,
          conversationId: seeded.conversation.id,
          userId: seeded.userId,
          content: "and check the logs",
          input: { modelId: textModelId, searchEnabled: false, researchEnabled: false },
          steerMessageId: seeded.assistant.id,
          steerGenerationId: seeded.assistant.generationId,
        });
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
          .where(eq(messages.id, seeded.assistant.id));
        yield* (yield* StreamEngine).reapOrphans;
        // A run settles its own call after the generation ended (research.md).
        yield* db.execute(
          sql`update message_tool_calls set status = 'complete', result = '{"outcome":"evidence"}'::jsonb where id = ${researchRow}`,
        );
        return { ...seeded, entryId, researchRow };
      }),
    );
    const reaped = await runtime.runPromise(ChatRepo.use((r) => r.getMessage(seed.assistant.id)));
    expect(reaped?.status).toBe("error");

    const gate = Deferred.makeUnsafe<void>();
    let first = "";
    authoringScript = (input) => {
      first ||= JSON.stringify(input.prompt);
      return Stream.fromEffectDrain(Deferred.await(gate)).pipe(Stream.concat(says("Done.")));
    };
    try {
      await runtime.runPromise(
        ChatService.use((service) =>
          service.resumeMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
            modelId: textModelId,
          }),
        ),
      );
      const claimed = await runtime.runPromise(
        Effect.gen(function* () {
          const db = yield* Db;
          const [entry] = yield* db
            .select()
            .from(conversationQueueEntries)
            .where(eq(conversationQueueEntries.id, seed.entryId));
          // Removed before the answer ends, so no queued turn follows it here.
          yield* db
            .delete(conversationQueueEntries)
            .where(eq(conversationQueueEntries.id, seed.entryId));
          return { entry, message: yield* (yield* ChatRepo).getMessage(seed.assistant.id) };
        }),
      );
      expect(claimed.entry?.steerGenerationId).toBe(claimed.message?.generationId);
      await runtime.runPromise(Deferred.succeed(gate, undefined));
      await runtime.runPromise(settle(seed.assistant.id));

      expect(first).toContain(
        '- run_command with {\\"command\\":\\"ls\\"}: outcome unknown, interrupted while running.',
      );
      expect(first).toContain("- deep_research: completed.");
      // After the round's record, where it arrived, and before the reminder.
      const record = first.indexOf("<application-record>");
      const steered = first.indexOf("use the staging box");
      expect(record).toBeGreaterThan(-1);
      expect(steered).toBeGreaterThan(record);
      expect(first.indexOf(RESUME_REMINDER)).toBeGreaterThan(steered);
      const after = await runtime.runPromise(
        ChatRepo.use((r) =>
          Effect.all({
            message: r.getMessage(seed.assistant.id),
            calls: r.listToolCalls([seed.assistant.id]),
          }),
        ),
      );
      expect(after.message).toMatchObject({
        status: "complete",
        content: "Checking the machine. Done.",
      });
      expect(after.calls.find((call) => call.id === seed.researchRow)).toMatchObject({
        status: "complete",
        result: { outcome: "evidence" },
      });
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("replays a failed answer's generated image as bytes when resumed", async () => {
    const { userId, conversationId } = await runtime.runPromise(chatOf);
    let calls = 0;
    const promptsBefore = streamPrompts.length;
    authoringScript = () => {
      calls += 1;
      if (calls === 1)
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "See this: " }),
          AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }),
          AiResponse.makePart("finish", {
            reason: "error",
            usage: new AiResponse.Usage({ inputTokens: { total: 12 }, outputTokens: { total: 4 } }),
          }),
        );
      return Stream.make(
        text(" continued"),
        AiResponse.makePart("finish", {
          reason: "stop",
          usage: new AiResponse.Usage({ inputTokens: { total: 12 }, outputTokens: { total: 4 } }),
          metadata: {},
        }),
      );
    };
    try {
      const messageId = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: imageModelId,
            content: "Draw this.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ).pipe(
          Effect.flatMap(({ assistantMessageId }) =>
            settle(assistantMessageId).pipe(Effect.as(assistantMessageId)),
          ),
        ),
      );
      const failed = await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(messageId)));
      expect(failed).toMatchObject({ status: "error", content: "See this: " });
      expect(failed?.assistantOutput?.files).toHaveLength(1);
      await runtime.runPromise(resume(userId, conversationId, messageId));
      const resumedPrompt = streamPrompts[promptsBefore + 1]!;
      const images = resumedPrompt.content.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "file" && part.data instanceof Uint8Array
                ? [Buffer.from(part.data).toString("base64")]
                : [],
            )
          : [],
      );
      expect(images).toEqual([generatedPng.toString("base64")]);
      const final = await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(messageId)));
      expect(final).toMatchObject({ status: "complete", content: "See this:  continued" });
      expect(final?.assistantOutput?.files).toHaveLength(1);
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("resumes an image answer on a model without vision, and later turns read it too", async () => {
    const { userId, conversationId } = await runtime.runPromise(chatOf);
    let calls = 0;
    const promptsBefore = streamPrompts.length;
    authoringScript = () => {
      calls += 1;
      if (calls === 1)
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "See this: " }),
          AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }),
          AiResponse.makePart("finish", {
            reason: "error",
            usage: new AiResponse.Usage({ inputTokens: { total: 12 }, outputTokens: { total: 4 } }),
          }),
        );
      return says(calls === 2 ? " continued" : "Sure.");
    };
    try {
      const messageId = await runtime.runPromise(
        ChatService.use((service) =>
          service.sendMessage({
            userId,
            conversation: { kind: "existing", id: conversationId },
            modelId: imageModelId,
            content: "Draw this.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ).pipe(
          Effect.flatMap(({ assistantMessageId }) =>
            settle(assistantMessageId).pipe(Effect.as(assistantMessageId)),
          ),
        ),
      );
      await runtime.runPromise(resume(userId, conversationId, messageId, textModelId));
      const resumed = await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(messageId)));
      expect(resumed).toMatchObject({ status: "complete", modelId: textModelId });
      expect(resumed?.assistantOutput?.files).toHaveLength(1);
      await runtime.runPromise(send(userId, conversationId, "Thanks, and now?"));
      const [resumedPrompt, followup] = streamPrompts.slice(promptsBefore + 1);
      for (const prompt of [resumedPrompt!, followup!]) {
        const serialized = JSON.stringify(prompt.content);
        expect(serialized).not.toContain('"type":"file"');
        expect(serialized).toContain(
          JSON.stringify(
            imageStandIn(resumed!.assistantOutput!.files[0]!.attachment.fileName),
          ).slice(1, -1),
        );
      }
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("refuses up front an answer out of turns, leaving it as it was", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const chat = yield* ChatService;
        const attempt = (
          seed: { userId: string; conversation: { id: string }; assistant: { id: string } },
          modelId?: string,
        ) =>
          chat
            .resumeMessage({
              userId: seed.userId,
              conversationId: seed.conversation.id,
              messageId: seed.assistant.id,
              ...(modelId ? { modelId } : {}),
            })
            .pipe(
              Effect.flip,
              Effect.map((error) =>
                error._tag === "ResumeNotAllowed" ? english(error.reason) : error._tag,
              ),
            );
        // Its host turns are used up; the next would enter research's space.
        const full = yield* failedAnswer("Partial ");
        yield* repo.insertToolCall({
          id: uuidv7(),
          messageId: full.assistant.id,
          turnIndex: 999,
          callIndex: 0,
          textOffset: 8,
          providerCallId: "last-host-round",
          toolName: "read_url",
          family: "web",
          arguments: {},
        });
        return {
          full: yield* attempt(full),
          fullAfter: yield* repo.getMessage(full.assistant.id),
        };
      }),
    );
    expect(outcome.full).toContain("continuation limit");
    expect(outcome.fullAfter).toMatchObject({
      status: "error",
      error: { tag: "GenerationFailed", message: "provider exploded" },
    });
  }, 60_000);

  it("continues on another model and drops the old model's signed turns", async () => {
    const seed = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* failedAnswer("Partial ");
        yield* (yield* Db)
          .update(messages)
          .set({
            providerReplay: {
              v: 1,
              turns: [
                {
                  turnIndex: 0,
                  startOffset: 0,
                  endOffset: 8,
                  unit: {
                    v: 1 as const,
                    id: "unit-1",
                    identity: {
                      provider: "p",
                      baseUrl: "https://provider.test/v1",
                      format: "chat-completions" as const,
                      model: "text",
                    },
                    format: "chat-completions" as const,
                    reasoningDetails: [{ type: "reasoning.encrypted", data: "signed" }],
                  },
                },
              ],
            },
          })
          .where(eq(messages.id, seeded.assistant.id));
        return seeded;
      }),
    );
    await runtime.runPromise(
      resume(seed.userId, seed.conversation.id, seed.assistant.id, visionModelId),
    );
    const final = await runtime.runPromise(ChatRepo.use((r) => r.getMessage(seed.assistant.id)));
    expect(final).toMatchObject({
      status: "complete",
      modelId: visionModelId,
      providerReplay: null,
      content: "Partial alpha beta gamma delta epsilon",
    });
  }, 60_000);

  it("refuses anything but the last failed or stopped answer, and only its owner", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const attempt = (userId: string, conversationId: string, messageId: string) =>
          chat.resumeMessage({ userId, conversationId, messageId }).pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          );
        const streaming = yield* setupConversation;
        const completed = yield* failedAnswer("done");
        yield* (yield* Db)
          .update(messages)
          .set({ status: "complete", error: null })
          .where(eq(messages.id, completed.assistant.id));
        const earlier = yield* failedAnswer("half");
        yield* repo.insertMessage({
          conversationId: earlier.conversation.id,
          role: "user",
          content: "never mind",
        });
        const stranger = yield* failedAnswer("mine");
        return {
          streaming: yield* attempt(
            streaming.userId,
            streaming.conversation.id,
            streaming.assistant.id,
          ),
          completed: yield* attempt(
            completed.userId,
            completed.conversation.id,
            completed.assistant.id,
          ),
          earlier: yield* attempt(earlier.userId, earlier.conversation.id, earlier.assistant.id),
          earlierRow: yield* repo.getMessage(earlier.assistant.id),
          stranger: yield* attempt(
            streaming.userId,
            stranger.conversation.id,
            stranger.assistant.id,
          ),
        };
      }),
    );
    expect(outcome).toMatchObject({
      streaming: "ResumeNotAllowed",
      completed: "ResumeNotAllowed",
      earlier: "ResumeNotAllowed",
      stranger: "ConversationNotFound",
    });
    // A refused claim leaves the answer exactly as it was.
    expect(outcome.earlierRow).toMatchObject({ status: "error", content: "half" });
  }, 60_000);

  it("fences the ended attempt out once a resume has claimed the answer", async () => {
    const seed = await runtime.runPromise(failedAnswer("Partial "));
    const oldFence = {
      userId: seed.userId,
      conversationId: seed.conversation.id,
      messageId: seed.assistant.id,
      generationId: seed.assistant.generationId!,
    };
    const gate = Deferred.makeUnsafe<void>();
    authoringScript = () =>
      Stream.fromEffectDrain(Deferred.await(gate)).pipe(Stream.concat(says("rest")));
    try {
      await runtime.runPromise(
        ChatService.use((service) =>
          service.resumeMessage({
            userId: seed.userId,
            conversationId: seed.conversation.id,
            messageId: seed.assistant.id,
          }),
        ),
      );
      const stale = await runtime.runPromise(
        ChatRepo.use((repo) =>
          Effect.exit(
            repo
              .appendChunks(seed.assistant.id, [{ seq: 2, kind: "text", delta: "STALE" }])
              .pipe(Effect.provideService(GenerationFence, oldFence)),
          ),
        ),
      );
      expect(Exit.hasInterrupts(stale)).toBe(true);
      await runtime.runPromise(Deferred.succeed(gate, undefined));
      await runtime.runPromise(settle(seed.assistant.id));
      const final = await runtime.runPromise(ChatRepo.use((r) => r.getMessage(seed.assistant.id)));
      expect(final).toMatchObject({ status: "complete", content: "Partial rest" });
    } finally {
      authoringScript = null;
    }
  }, 60_000);

  it("continues past the row positions the answer already used", async () => {
    const seed = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* failedAnswer("Otters hold hands [^3]. ");
        const db = yield* Db;
        const row = (overrides: Partial<typeof messageToolCalls.$inferInsert>) => ({
          id: uuidv7(),
          messageId: seeded.assistant.id,
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          providerCallId: uuidv7(),
          toolName: "web_search",
          family: "web" as const,
          arguments: {},
          status: "complete" as const,
          ...overrides,
        });
        // Where an attempt writes its direct context, pinned skills and the
        // initial history compaction: all at the first turn.
        yield* db.insert(messageToolCalls).values([
          row({
            providerCallId: `knowledge-context:${uuidv7()}`,
            toolName: "knowledge_context",
            family: "knowledge",
            result: { sources: [] },
          }),
          row({
            callIndex: -5,
            providerCallId: `skill-context:${uuidv7()}`,
            toolName: "load_skill",
            family: "skill",
            result: { skillId: "s1" },
          }),
          row({
            callIndex: 1,
            arguments: { queries: ["otters"] },
            result: {
              sources: [
                {
                  index: 3,
                  kind: "web",
                  title: "Otter facts",
                  url: "https://otters.example/facts",
                  snippet: "Otters hold hands.",
                  read: false,
                },
              ],
            },
          }),
        ]);
        yield* db.insert(messageCompactionEvents).values({
          id: uuidv7(),
          messageId: seeded.assistant.id,
          beforeTurnIndex: 0,
          passIndex: 0,
          scope: "history",
          status: "complete",
          outcome: "hard_truncation",
        });
        return seeded;
      }),
    );
    let round = 0;
    let first = "";
    authoringScript = (input) => {
      round += 1;
      if (round === 1) {
        first = JSON.stringify(input.prompt);
        return saysThenCalls(input, "More: ", "create_document", { title: "Otters", content: "-" });
      }
      return says("done.");
    };
    try {
      await runtime.runPromise(resume(seed.userId, seed.conversation.id, seed.assistant.id));
      const calls = await runtime.runPromise(
        ChatRepo.use((repo) => repo.listToolCalls([seed.assistant.id])),
      );
      expect(calls.map((call) => [call.toolName, call.turnIndex, call.callIndex])).toEqual([
        ["load_skill", 0, -5],
        ["knowledge_context", 0, 0],
        ["web_search", 0, 1],
        ["create_document", 1, 0],
      ]);
      // Only the model's own call is on the record; application rows are not.
      expect(first).toContain("- web_search with");
      expect(first).not.toContain("- knowledge_context");
      expect(first).not.toContain("- load_skill");
      expect(
        (await runtime.runPromise(ChatRepo.use((repo) => repo.getMessage(seed.assistant.id))))
          ?.status,
      ).toBe("complete");
    } finally {
      authoringScript = null;
    }
  }, 60_000);
});

describe("image generation tool", () => {
  // An OpenAI preset pointed at a host nothing else uses; its image calls are
  // answered by the fetch stub below, everything else goes through untouched.
  const IMAGE_BASE = "http://images.integration.test/v1";
  let imageProviderModelId: string;
  let secondImageModelId: string;
  type ImageAnswer = { status: number; body: unknown } | "hang";
  const imageAnswers: ImageAnswer[] = [];
  const imageRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  /** Set to hold a streamed answer after its first draft until it resolves. */
  let previewGate: Promise<void> | null = null;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(IMAGE_BASE)) return realFetch(input, init);
      // The client sends bytes, or a form for edits; either way the fields are read back.
      const request = new Request(url, {
        method: init?.method ?? "POST",
        headers: init?.headers ?? {},
        ...(init?.body ? { body: init.body as BodyInit } : {}),
      });
      const type = request.headers.get("content-type") ?? "";
      const body = type.includes("multipart")
        ? Object.fromEntries(
            [...(await request.formData()).entries()].map(([key, value]) => [
              key,
              typeof value === "string" ? value : "<file>",
            ]),
          )
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
      imageRequests.push({ url, body });
      const answer = imageAnswers.shift() ?? {
        status: 200,
        body: {
          data: [{ b64_json: generatedPng.toString("base64") }],
          usage: {
            input_tokens: 20,
            input_tokens_details: { text_tokens: 20, image_tokens: 0 },
            output_tokens: 1000,
          },
        },
      };
      if (answer === "hang")
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      // GPT Image streams when the engine asks for previews: the same answer
      // as events, one draft first, or the error event a refusal becomes.
      if (body["stream"] === true || body["stream"] === "true") {
        const reply = answer.body as {
          data?: Array<{ b64_json: string }>;
          usage?: unknown;
          error?: unknown;
        };
        const kind = url.endsWith("/edits") ? "image_edit" : "image_generation";
        const events =
          answer.status !== 200
            ? [{ type: "error", error: reply.error }]
            : [
                {
                  type: `${kind}.partial_image`,
                  b64_json: editedPng.toString("base64"),
                  partial_image_index: 0,
                },
                {
                  type: `${kind}.completed`,
                  b64_json: reply.data![0]!.b64_json,
                  usage: reply.usage,
                },
              ];
        const encoder = new TextEncoder();
        const gate = previewGate;
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (const [index, event] of events.entries()) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                // A test can hold the stream after the draft, while the call is still running.
                if (index === 0 && gate) await gate;
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    });
    const created = await runtime.runPromise(
      Effect.gen(function* () {
        const providers = yield* ProviderRepo;
        const provider = yield* providers.createProvider({
          name: "Images",
          preset: "openai",
          baseUrl: IMAGE_BASE,
          apiKey: "test-key",
        });
        const settings = (displayName: string) => ({
          displayName,
          description: "Good at text in images",
          type: "image" as const,
          contextLength: null,
          embeddingDimensions: null,
          capabilities: {
            imageOutput: false,
            reasoning: false,
            tools: false,
            vision: false,
            files: false,
          },
          pricing: null,
          imageFamily: "gpt-image" as const,
          imageCapabilities: {
            generate: true,
            edit: { maxReferences: 4 },
            aspectRatios: ["1:1", "3:2", "2:3"] as const,
            qualities: ["low", "medium", "high"] as const,
            transparency: true,
            maxCount: 4,
          },
          imagePricing: { perImage: { default: 0.04 } },
          enabled: true,
          access: "public" as const,
          groupIds: [],
        });
        const first = yield* providers.createModel({
          providerId: provider.id,
          modelKey: "gpt-image-1",
          ...settings("GPT Image"),
        });
        const second = yield* providers.createModel({
          providerId: provider.id,
          modelKey: "gpt-image-1-mini",
          ...settings("GPT Image Mini"),
        });
        yield* providers.setDefaultModelOrder([first.id, second.id], "image");
        return { first: first.id, second: second.id };
      }),
    );
    imageProviderModelId = created.first;
    secondImageModelId = created.second;
  });

  afterAll(() => {
    vi.mocked(globalThis.fetch).mockRestore();
  });

  const chat = Effect.gen(function* () {
    const seed = yield* setupConversation;
    const conversation = yield* (yield* ChatRepo).createConversation({
      userId: seed.userId,
      modelId: textModelId,
    });
    return { ...seed, conversation };
  });

  const send = (seed: { userId: string; conversation: { id: string } }, pickedImage?: string) =>
    runtime.runPromise(
      Effect.flatMap(ChatService, (service) =>
        service.sendMessage({
          userId: seed.userId,
          conversation: { kind: "existing", id: seed.conversation.id },
          modelId: textModelId,
          content: "Draw a cube.",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
          ...(pickedImage ? { imageModelId: pickedImage } : {}),
        }),
      ),
    );
  const collect = (id: string) =>
    runtime.runPromise(
      Effect.flatMap(StreamEngine, (engine) => Stream.runCollect(engine.subscribe(id, 0))),
    );
  const ledger = (messageId: string) =>
    runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db
          .select()
          .from(usageEvents)
          .where(and(eq(usageEvents.messageId, messageId), eq(usageEvents.kind, "image"))),
      ),
    );

  it("draws with the chat's image model, stores the image under its call and locks the model", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) {
        expect(Object.keys(input.toolkit?.tools ?? {})).toContain("generate_image");
        // The model is named after history, so the cached prefix never holds it.
        const trailing = JSON.stringify(input.prompt.content.slice(-3));
        expect(trailing).toContain("GPT Image");
        return authoringTool(input, "generate_image", {
          prompt: "A red cube",
          aspect_ratio: "16:9",
          quality: "high",
        });
      }
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Here is the cube." }),
        authoringFinish(),
      );
    };
    imageRequests.length = 0;
    try {
      const { assistantMessageId, conversationId } = await send(seed);
      await collect(assistantMessageId);
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const message = detail.messages.find((row) => row.id === assistantMessageId)!;
      expect(message.status).toBe("complete");
      const call = detail.toolCalls.find((row) => row.toolName === "generate_image")!;
      expect(call.status).toBe("complete");
      const files = message.assistantOutput?.files ?? [];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ source: "image-tool", origin: { toolCallId: call.id } });
      expect(call.result).toMatchObject({
        family: "image",
        status: "complete",
        model: "GPT Image",
        attachmentIds: [files[0]!.attachment.id],
      });
      // 16:9 is not one this model allows: the nearest it does is used and said.
      expect(imageRequests[0]?.url).toBe(`${IMAGE_BASE}/images/generations`);
      expect(imageRequests[0]?.body).toMatchObject({ model: "gpt-image-1", quality: "high" });
      expect((call.result as { adjustments?: string[] }).adjustments?.length).toBeGreaterThan(0);
      const [usage] = await ledger(assistantMessageId);
      expect(usage).toMatchObject({
        status: "complete",
        imageCount: 1,
        toolCallId: call.id,
        modelId: imageProviderModelId,
      });
      expect(usage?.cost).not.toBeNull();
      const stored = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          Effect.all([
            db
              .select({ lock: conversations.imageModelId })
              .from(conversations)
              .where(eq(conversations.id, conversationId)),
            db
              .select({ id: messageGenerationConfig.imageModelId })
              .from(messageGenerationConfig)
              .where(eq(messageGenerationConfig.messageId, assistantMessageId)),
          ]),
        ),
      );
      expect(stored[0][0]?.lock).toBe(imageProviderModelId);
      expect(stored[1][0]?.id).toBe(imageProviderModelId);
    } finally {
      authoringScript = null;
    }
  });

  it("shows the newest draft while it draws, to a page that subscribes late too", async () => {
    const seed = await runtime.runPromise(chat);
    let release!: () => void;
    previewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) return authoringTool(input, "generate_image", { prompt: "Slowly" });
      return Stream.make(authoringFinish());
    };
    const firstPreview = (id: string) =>
      runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          engine.subscribe(id, 0).pipe(
            Stream.filter((event) => event.kind === "preview" || event.kind === "done"),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
    try {
      const { assistantMessageId } = await send(seed);
      const [live] = await firstPreview(assistantMessageId);
      expect(live).toMatchObject({ kind: "preview", mediaType: "image/png" });
      // A reload: the draft comes from the snapshot, and the running row names its model.
      const [late] = await firstPreview(assistantMessageId);
      expect(late).toMatchObject({
        kind: "preview",
        callId: (live as { callId: string }).callId,
      });
      const [row] = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({ status: messageToolCalls.status, result: messageToolCalls.result })
            .from(messageToolCalls)
            .where(eq(messageToolCalls.messageId, assistantMessageId)),
        ),
      );
      expect(row).toMatchObject({
        status: "running",
        result: { family: "image", status: "running", model: "GPT Image" },
      });
      release();
      await collect(assistantMessageId);
      // Drafts are never kept: a page opened afterwards sees only the image.
      const after = await runtime.runPromise(
        Effect.flatMap(StreamEngine, (engine) =>
          engine.subscribe(assistantMessageId, 0).pipe(Stream.runCollect),
        ),
      );
      expect([...after].some((event) => event.kind === "preview")).toBe(false);
      expect((await ledger(assistantMessageId))[0]?.imageCount).toBe(1);
    } finally {
      previewGate = null;
      authoringScript = null;
    }
  });

  it("finishes an answer that is only an image, and switches model when one is picked", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) {
        expect(JSON.stringify(input.prompt.content.slice(-3))).toContain("GPT Image Mini");
        return authoringTool(input, "generate_image", { prompt: "A blue cube" });
      }
      return Stream.make(authoringFinish());
    };
    imageRequests.length = 0;
    try {
      const { assistantMessageId, conversationId } = await send(seed, secondImageModelId);
      await collect(assistantMessageId);
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const message = detail.messages.find((row) => row.id === assistantMessageId)!;
      expect(message.status).toBe("complete");
      expect(message.assistantOutput?.files).toHaveLength(1);
      expect(imageRequests[0]?.body).toMatchObject({ model: "gpt-image-1-mini" });
      const [row] = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({ lock: conversations.imageModelId })
            .from(conversations)
            .where(eq(conversations.id, conversationId)),
        ),
      );
      expect(row?.lock).toBe(secondImageModelId);
    } finally {
      authoringScript = null;
    }
  });

  it("resumes without the tool rather than switch from the model the answer drew with", async () => {
    const seed = await runtime.runPromise(chat);
    const offered: boolean[] = [];
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      offered.push(Object.keys(input.toolkit?.tools ?? {}).includes("generate_image"));
      if (round === 1)
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Drawing " }),
          AiResponse.makePart("finish", {
            reason: "error",
            usage: new AiResponse.Usage({ inputTokens: { total: 1 }, outputTokens: { total: 1 } }),
          }),
        );
      return Stream.make(authoringFinish());
    };
    const setEnabled = (enabled: boolean) =>
      runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db.update(models).set({ enabled }).where(eq(models.id, secondImageModelId)),
        ),
      );
    try {
      const { assistantMessageId, conversationId } = await send(seed, secondImageModelId);
      await collect(assistantMessageId);
      await setEnabled(false);
      await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.resumeMessage({
            userId: seed.userId,
            conversationId,
            messageId: assistantMessageId,
          }),
        ),
      );
      await collect(assistantMessageId);
      expect(offered).toEqual([true, false]);
      const [row] = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({ lock: conversations.imageModelId })
            .from(conversations)
            .where(eq(conversations.id, conversationId)),
        ),
      );
      expect(row?.lock).toBe(secondImageModelId);
    } finally {
      await setEnabled(true);
      authoringScript = null;
    }
  });

  it("counts the model's own images against the tool's, so it draws nothing it cannot keep", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      // The first call draws nothing, so the second comes in a round after the images landed.
      if (round === 1)
        return authoringTool(
          input,
          "generate_image",
          { prompt: "" },
          false,
          Array.from({ length: ASSISTANT_FILE_LIMITS.images }, () =>
            AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }),
          ),
        );
      if (round === 2) return authoringTool(input, "generate_image", { prompt: "One more" });
      return Stream.make(authoringFinish());
    };
    imageRequests.length = 0;
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: imageModelId,
            content: "Draw many.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collect(assistantMessageId);
      const calls = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.listToolCalls([assistantMessageId])),
      );
      expect(calls[1]).toMatchObject({ toolName: "generate_image", status: "error" });
      expect(JSON.stringify(calls[1]?.result)).toContain("as many images as it may");
      expect(imageRequests).toHaveLength(0);
    } finally {
      authoringScript = null;
    }
  });

  it("keeps a call's image when the model's own filled the count after it reserved", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      // The call runs ahead of the images streamed before it, so its budget is still open.
      if (round === 1)
        return authoringTool(
          input,
          "generate_image",
          { prompt: "One more" },
          false,
          Array.from({ length: ASSISTANT_FILE_LIMITS.images }, () =>
            AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }),
          ),
        );
      return Stream.make(authoringFinish());
    };
    // Seventeen images read back in the next round sit at the default context's
    // compaction line, and this test is about keeping them, not compacting.
    const setContext = (contextLength: number | null) =>
      runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db.update(models).set({ contextLength }).where(eq(models.id, imageModelId)),
        ),
      );
    await setContext(1_000_000);
    imageRequests.length = 0;
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: imageModelId,
            content: "Draw many.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collect(assistantMessageId);
      const message = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.getMessage(assistantMessageId)),
      );
      expect(message?.status).toBe("complete");
      // Both were paid for, so both are kept; only the byte ceilings bound a reserved slot.
      const files = message?.assistantOutput?.files ?? [];
      expect(files).toHaveLength(ASSISTANT_FILE_LIMITS.images + 1);
      const [call] = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.listToolCalls([assistantMessageId])),
      );
      expect(call).toMatchObject({ toolName: "generate_image", status: "complete" });
      expect(files.at(-1)).toMatchObject({
        source: "image-tool",
        origin: { toolCallId: call!.id },
      });
      expect(imageRequests).toHaveLength(1);
      const [usage] = await ledger(assistantMessageId);
      expect(usage).toMatchObject({ status: "complete", imageCount: 1, toolCallId: call!.id });
    } finally {
      await setContext(null);
      authoringScript = null;
    }
  });

  it("keeps the model's own images after a call's, up to their own count", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) return authoringTool(input, "generate_image", { prompt: "First" });
      return Stream.make(
        ...Array.from({ length: ASSISTANT_FILE_LIMITS.images }, () =>
          AiResponse.makePart("file", { mediaType: "image/png", data: generatedPng }),
        ),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId } = await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: seed.conversation.id },
            modelId: imageModelId,
            content: "Draw many.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          }),
        ),
      );
      await collect(assistantMessageId);
      const message = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.getMessage(assistantMessageId)),
      );
      expect(message?.status).toBe("complete");
      expect(message?.assistantOutput?.files.map((file) => file.source)).toEqual([
        "image-tool",
        ...Array.from({ length: ASSISTANT_FILE_LIMITS.images }, () => "native"),
      ]);
    } finally {
      authoringScript = null;
    }
  });

  it("says when only some of a call's images could be kept", async () => {
    const seed = await runtime.runPromise(chat);
    const png = generatedPng.toString("base64");
    imageAnswers.push({ status: 200, body: { data: [{ b64_json: png }, { b64_json: png }] } });
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round > 1) return Stream.make(authoringFinish());
      // The answer already holds all but room for one more image, by its bytes.
      return Stream.unwrap(
        Effect.promise(async () => {
          await runtime.runPromise(
            Effect.flatMap(Db, (db) =>
              db
                .update(messages)
                .set({
                  assistantOutput: {
                    v: 1,
                    files: [
                      {
                        v: 1,
                        attachment: {
                          id: "held",
                          fileName: "held.png",
                          size: ASSISTANT_FILE_LIMITS.answerBytes - generatedPng.length,
                          mediaType: "image/png",
                          kind: "image",
                        },
                        textOffset: 0,
                        turnIndex: 0,
                        eventIndex: 0,
                        callIndex: 0,
                        source: "native",
                      },
                    ],
                  },
                })
                .where(
                  and(
                    eq(messages.conversationId, seed.conversation.id),
                    eq(messages.status, "streaming"),
                  ),
                ),
            ),
          );
          return authoringTool(input, "generate_image", { prompt: "Two", count: 2 });
        }),
      );
    };
    try {
      const { assistantMessageId } = await send(seed);
      await collect(assistantMessageId);
      const [call] = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.listToolCalls([assistantMessageId])),
      );
      expect(call).toMatchObject({ toolName: "generate_image", status: "complete" });
      expect((call!.result as { attachmentIds: string[] }).attachmentIds).toHaveLength(1);
      expect((call!.result as { adjustments?: string[] }).adjustments?.[0]).toMatch(
        /^1 of 2 images could not be kept/,
      );
    } finally {
      authoringScript = null;
    }
  });

  it("retries with the image model picked for the retry, and moves the lock", async () => {
    const seed = await runtime.runPromise(chat);
    authoringScript = (input) =>
      JSON.stringify(input.prompt.content).includes("tool-result")
        ? Stream.make(authoringFinish())
        : authoringTool(input, "generate_image", { prompt: "A cube" });
    imageRequests.length = 0;
    try {
      const { assistantMessageId, conversationId } = await send(seed);
      await collect(assistantMessageId);
      await runtime.runPromise(
        Effect.flatMap(ChatService, (service) =>
          service.retryMessage({
            userId: seed.userId,
            conversationId,
            messageId: assistantMessageId,
            imageModelId: secondImageModelId,
          }),
        ),
      );
      await collect(assistantMessageId);
      expect(imageRequests.map((row) => row.body.model)).toEqual([
        "gpt-image-1",
        "gpt-image-1-mini",
      ]);
      const [row] = await runtime.runPromise(
        Effect.flatMap(Db, (db) =>
          db
            .select({ lock: conversations.imageModelId })
            .from(conversations)
            .where(eq(conversations.id, conversationId)),
        ),
      );
      expect(row?.lock).toBe(secondImageModelId);
    } finally {
      authoringScript = null;
    }
  });

  it("reports a refusal in the call and lets the answer go on", async () => {
    const seed = await runtime.runPromise(chat);
    imageAnswers.push({
      status: 400,
      body: {
        error: {
          code: "moderation_blocked",
          message: "Your request was rejected by the safety system.",
        },
      },
    });
    let round = 0;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) return authoringTool(input, "generate_image", { prompt: "Something" });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "It was declined." }),
        authoringFinish(),
      );
    };
    try {
      const { assistantMessageId, conversationId } = await send(seed);
      await collect(assistantMessageId);
      const detail = await runtime.runPromise(loadConversationDetail(seed.userId, conversationId));
      const message = detail.messages.find((row) => row.id === assistantMessageId)!;
      expect(message.status).toBe("complete");
      expect(message.assistantOutput?.files ?? []).toHaveLength(0);
      const call = detail.toolCalls.find((row) => row.toolName === "generate_image")!;
      expect(call.status).toBe("error");
      expect(call.result).toMatchObject({
        family: "image",
        refusal: expect.stringContaining("rejected"),
      });
      const [usage] = await ledger(assistantMessageId);
      expect(usage).toMatchObject({ imageCount: 0 });
    } finally {
      authoringScript = null;
    }
  });

  it("edits an image the chat holds, passed by its file link", async () => {
    const seed = await runtime.runPromise(chat);
    let round = 0;
    let firstImage: string | undefined;
    authoringScript = (input) => {
      round += 1;
      if (round === 1) return authoringTool(input, "generate_image", { prompt: "A cube" });
      if (round === 2)
        return Stream.make(
          AiResponse.makePart("text-delta", { id: "t", delta: "Made it." }),
          authoringFinish(),
        );
      if (round === 3)
        return authoringTool(input, "generate_image", {
          prompt: "Make it green",
          references: [`/api/files/${firstImage}`],
        });
      return Stream.make(
        AiResponse.makePart("text-delta", { id: "t", delta: "Edited." }),
        authoringFinish(),
      );
    };
    imageRequests.length = 0;
    try {
      const first = await send(seed);
      await collect(first.assistantMessageId);
      const detail = await runtime.runPromise(
        loadConversationDetail(seed.userId, first.conversationId),
      );
      firstImage = detail.messages.find((row) => row.id === first.assistantMessageId)!
        .assistantOutput!.files[0]!.attachment.id;
      const second = await send(seed);
      await collect(second.assistantMessageId);
      const after = await runtime.runPromise(
        loadConversationDetail(seed.userId, first.conversationId),
      );
      const call = after.toolCalls.find(
        (row) => row.toolName === "generate_image" && row.messageId === second.assistantMessageId,
      )!;
      expect(call.status).toBe("complete");
      expect(call.result).toMatchObject({ editing: true });
      expect(imageRequests.at(-1)?.url).toBe(`${IMAGE_BASE}/images/edits`);
    } finally {
      authoringScript = null;
    }
  });

  it("aborts the request on Stop, stores nothing and records the call as aborted", async () => {
    const seed = await runtime.runPromise(chat);
    imageAnswers.push("hang");
    authoringScript = (input) => authoringTool(input, "generate_image", { prompt: "Slow" });
    try {
      const { assistantMessageId } = await send(seed);
      // Waits on the request reaching the provider, not on a clock.
      await vi.waitFor(() =>
        expect(imageRequests.some((row) => row.body.prompt === "Slow")).toBe(true),
      );
      const stopped = await runtime.runPromise(
        Effect.gen(function* () {
          const running = yield* (yield* ChatRepo).getMessage(assistantMessageId);
          return yield* (yield* StreamEngine).stopGeneration(
            assistantMessageId,
            running?.generationId ?? undefined,
          );
        }),
      );
      expect(stopped).toBe(true);
      await collect(assistantMessageId);
      const message = await runtime.runPromise(
        Effect.flatMap(ChatRepo, (repo) => repo.getMessage(assistantMessageId)),
      );
      expect(message?.status).not.toBe("streaming");
      expect(message?.assistantOutput?.files ?? []).toHaveLength(0);
      await vi.waitFor(async () => {
        const [usage] = await ledger(assistantMessageId);
        expect(usage).toMatchObject({ status: "aborted", imageCount: 0, usageComplete: false });
      });
    } finally {
      authoringScript = null;
    }
  });
});

describe("chunk retention", () => {
  it("drops a settled answer's chunks after an hour, and keeps them for resume", async () => {
    const left = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const { conversation } = yield* setupConversation;
        const answer = (status: "complete" | "error" | "aborted", minutesAgo: number) =>
          Effect.gen(function* () {
            const id = uuidv7();
            yield* db.insert(messages).values({
              id,
              conversationId: conversation.id,
              role: "assistant",
              status,
              content: "done",
              completedAt: sql`now() - make_interval(mins => ${minutesAgo})`,
            });
            yield* db.insert(messageChunks).values([
              { messageId: id, seq: 1, delta: "do" },
              { messageId: id, seq: 2, delta: "ne" },
            ]);
            return id;
          });
        const ids = {
          old: yield* answer("complete", 61),
          recent: yield* answer("complete", 59),
          failed: yield* answer("error", 120),
          stopped: yield* answer("aborted", 120),
        };
        yield* repo.sweepCompletedChunks();
        const kept = yield* db
          .selectDistinct({ id: messageChunks.messageId })
          .from(messageChunks)
          .where(sql`${messageChunks.messageId} in ${Object.values(ids)}`);
        const names = Object.entries(ids);
        return kept.map((row) => names.find(([, id]) => id === row.id)?.[0]).toSorted();
      }),
    );
    expect(left).toEqual(["failed", "recent", "stopped"]);
  });
});

describe("the live tail", () => {
  const chunkSeqs = (events: Iterable<StreamEvent>) =>
    [...events].flatMap((event) => (event.kind === "chunk" ? [event.seq] : []));

  it("reads back what a reader too slow for the live events missed, in order", async () => {
    const deltas = 5000;
    const go = Effect.runSync(Deferred.make<void>());
    authoringScript = () =>
      Stream.make(AiResponse.makePart("text-delta", { id: "t", delta: "start " })).pipe(
        Stream.concat(
          Stream.fromEffect(Deferred.await(go)).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable(
                Array.from({ length: deltas }, () =>
                  AiResponse.makePart("text-delta", { id: "t", delta: "x" }),
                ),
              ),
            ),
          ),
        ),
        Stream.concat(Stream.make(authoringFinish())),
      ) as Stream.Stream<ChatStreamPart>;
    try {
      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const seed = yield* setupConversation;
          const conversation = yield* (yield* ChatRepo).createConversation({
            userId: seed.userId,
            modelId: textModelId,
          });
          const { assistantMessageId } = yield* (yield* ChatService).sendMessage({
            userId: seed.userId,
            conversation: { kind: "existing", id: conversation.id },
            modelId: textModelId,
            content: "Go.",
            searchEnabled: false,
            researchEnabled: false,
            attachmentIds: [],
          });
          const engine = yield* StreamEngine;
          let first = true;
          // On its first chunk the reader stops until the answer has settled,
          // while far more events than the live buffer holds go past it.
          return yield* Stream.runCollect(
            engine.subscribe(assistantMessageId, 0).pipe(
              Stream.tap((event) => {
                if (event.kind !== "chunk" || !first) return Effect.void;
                first = false;
                return Deferred.succeed(go, undefined).pipe(
                  Effect.andThen(engine.awaitSettled(assistantMessageId, event.generationId)),
                );
              }),
            ),
          );
        }),
      );
      const seqs = chunkSeqs(events);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
      expect(seqs.length).toBeGreaterThan(deltas);
      expect([...events].at(-1)).toMatchObject({ kind: "done", status: "complete" });
    } finally {
      authoringScript = null;
    }
  });

  it("ends a tail whose done it never heard once the row has settled", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Db;
        const engine = yield* StreamEngine;
        const { assistant } = yield* setupConversation;
        // Streaming under a live lease, with no generation running here to say it ended.
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: sql`clock_timestamp() + interval '1 minute'` })
          .where(eq(messages.id, assistant.id));
        yield* db.insert(messageChunks).values({ messageId: assistant.id, seq: 1, delta: "Hel" });
        let settledIt = false;
        return yield* Stream.runCollect(
          engine.subscribe(assistant.id, 0).pipe(
            Stream.tap((event) => {
              if (settledIt || event.kind !== "chunk") return Effect.void;
              settledIt = true;
              // Settled behind the tail's back: one more chunk, then complete.
              return Effect.gen(function* () {
                yield* db
                  .insert(messageChunks)
                  .values({ messageId: assistant.id, seq: 2, delta: "lo" });
                yield* db
                  .update(messages)
                  .set({ status: "complete", content: "Hello", completedAt: new Date() })
                  .where(eq(messages.id, assistant.id));
              });
            }),
          ),
        ).pipe(
          Effect.provideService(SettledCheckInterval, Duration.millis(20)),
          Effect.timeout(Duration.seconds(10)),
        );
      }),
    );
    expect(chunkSeqs(result)).toEqual([1, 2]);
    expect([...result].at(-1)).toMatchObject({ kind: "done", status: "complete" });
  });
});

describe("list hints", () => {
  it("announces a new answer as created and then streaming, before it starts", async () => {
    const { events, conversationId, assistantMessageId } = await runtime.runPromise(
      Effect.gen(function* () {
        const seed = yield* setupConversation;
        const conversation = yield* (yield* ChatRepo).createConversation({
          userId: seed.userId,
          modelId: textModelId,
        });
        const bus = yield* SyncBus;
        const ready = yield* Deferred.make<void>();
        const heard = yield* bus.subscribe(seed.userId, true).pipe(
          Stream.tap((event) =>
            event.type === "sync.ready" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.filter(
            (event) => event.type === "message.created" || event.type === "message.status",
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        const sent = yield* (yield* ChatService).sendMessage({
          userId: seed.userId,
          conversation: { kind: "existing", id: conversation.id },
          modelId: textModelId,
          content: "Hello.",
          searchEnabled: false,
          researchEnabled: false,
          attachmentIds: [],
        });
        return {
          events: [...(yield* Fiber.join(heard))],
          conversationId: conversation.id,
          assistantMessageId: sent.assistantMessageId,
        };
      }),
    );
    const about = { conversationId, messageId: assistantMessageId };
    expect(events).toEqual([
      { type: "message.created", ...about },
      { type: "message.status", ...about, status: "streaming" },
      { type: "message.status", ...about, status: "complete" },
    ]);
  });
});

describe("the message stream route's owner check", () => {
  it("opens an answer's stream for its owner alone", async () => {
    const opened = await runtime.runPromise(
      Effect.gen(function* () {
        const owner = yield* setupConversation;
        const stranger = yield* setupConversation;
        const open = (userId: string, messageId: string) =>
          openMessageStream({
            userId,
            sessionId: userId,
            messageId,
            afterSeq: 0,
            generationId: undefined,
          }).pipe(Effect.map((stream) => stream !== null));
        return {
          owner: yield* open(owner.userId, owner.assistant.id),
          stranger: yield* open(stranger.userId, owner.assistant.id),
          unknown: yield* open(owner.userId, uuidv7()),
        };
      }),
    );
    expect(opened).toEqual({ owner: true, stranger: false, unknown: false });
  });
});
