import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { Response as AiResponse, type Prompt } from "effect/unstable/ai";
import { eq } from "drizzle-orm";
import {
  attachmentBlobs,
  attachments,
  messageAttachments,
  messages,
  models,
  usageEvents,
} from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
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
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AiGateway, type ChatStreamPart } from "~/modules/providers/server/gateway.ts";
import { hermesToolCalls } from "~/modules/providers/server/hermes-tools.ts";
import { askUserTool } from "~/modules/tools/server/ask-user.ts";
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
  | ChatRepo
  | ChatService
  | StreamEngine
  | SyncBus
  | Db
  | AttachmentRepo
  | AttachmentService,
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
  // A finished exchange whose answer came from `originalModelId` — the state
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
