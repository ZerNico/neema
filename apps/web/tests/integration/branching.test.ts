import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  attachments,
  conversations as conversationsTable,
  conversationWorkingFiles,
  messageAttachments,
  messages,
  models,
} from "~/db/schema/index.ts";
import { Response as AiResponse } from "effect/unstable/ai";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { ExternalCompletion } from "~/modules/tools/server/external-completion.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo, type MessageRow } from "~/modules/chat/server/repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
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
import { outlastGrace, purgeConversation } from "./purge.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { FakeMemoryService } from "./fake-memory.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { hashSource } from "~/modules/genui/fences.ts";

// ProviderRepo decrypts stored keys through KeyCipher, which reads this.
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
type Services = ChatRepo | ChatService | CustomToolRepo | AttachmentRepo | SyncBus | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
/** messages.model_id / conversations.model_id are real FKs. */
let modelId: string;
let providerId: string;

// Only titles are generated here. Nothing in this file streams an answer.
const GENERATED_TITLE = "Forked thread";
const fakeGeneratedText = (text: string) =>
  Effect.succeed({
    text,
    usage: new AiResponse.Usage({
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }),
    finishMetadata: undefined,
  });

const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  probeChatModel: () => Effect.die("no model probes in these tests"),
  // These suites never embed; a call here means the code under test grew a
  // provider dependency the fake was not asked to model.
  embed: () => Effect.die("unexpected embed call"),
  generateText: () => fakeGeneratedText(GENERATED_TITLE),
  streamChat: () => Stream.fromEffect(Effect.die("no generation in these tests")),
});

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
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
    Layer.provideMerge(Layer.mergeAll(AttachmentRepo.layer, KeyCipher.layer)),
    Layer.provideMerge(FeaturePolicy.layer),
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

  modelId = uuidv7();
  providerId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute(
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'p', 'openrouter', 'http://x', 'x')` as never,
      );
      yield* db.insert(models).values({
        id: modelId,
        providerId,
        modelKey: "m",
        displayName: "M",
        type: "chat",
      });
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

const BASE = new Date("2026-03-01T12:00:00Z").getTime();

/**
 * A finished thread with explicit timestamps: `listMessages` orders by
 * createdAt, and stamping them keeps the expected prefix exact rather than
 * dependent on how fast the inserts ran. `assistant: null` leaves that answer
 * streaming.
 */
const seedThread = Effect.fn("test.seedThread")(function* (
  userId: string,
  turns: ReadonlyArray<{ user: string; assistant: string | null }>,
  options: { model?: string | null; title?: string } = {},
) {
  const repo = yield* ChatRepo;
  const db = yield* Db;
  const model = options.model === undefined ? modelId : options.model;
  const conversation = yield* repo.createConversation({ userId, modelId: model as never });
  if (options.title !== undefined) {
    yield* repo.updateConversation(conversation.id, { title: options.title });
  }

  let tick = 0;
  const stamp = () => new Date(BASE + tick++ * 60_000);
  for (const turn of turns) {
    const user = yield* repo.insertMessage({
      conversationId: conversation.id,
      role: "user",
      content: turn.user,
    });
    yield* db.update(messages).set({ createdAt: stamp() }).where(eq(messages.id, user.id));

    const assistant = yield* repo.insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      status: "streaming",
      ...(model ? { modelId: model } : {}),
    });
    if (turn.assistant !== null) {
      yield* repo.finalizeMessage({
        messageId: assistant.id,
        status: "complete",
        content: turn.assistant,
      });
    }
    const at = stamp();
    yield* db
      .update(messages)
      .set({
        createdAt: at,
        completedAt: turn.assistant === null ? null : new Date(at.getTime() + 5_000),
      })
      .where(eq(messages.id, assistant.id));
  }

  return {
    conversation: yield* repo.getConversation(userId, conversation.id),
    messages: yield* repo.listMessages(conversation.id),
  };
});

/** Everything but identity: what a clone has to reproduce exactly. */
const shape = (message: MessageRow) => ({
  role: message.role,
  status: message.status,
  content: message.content,
  reasoning: message.reasoning,
  modelId: message.modelId,
  usage: message.usage,
  error: message.error,
  createdAt: message.createdAt,
  completedAt: message.completedAt,
  editedAt: message.editedAt,
});

const attach = Effect.fn("test.attach")(function* (
  userId: string,
  messageId: string,
  files: ReadonlyArray<{ fileName: string; position: number }>,
) {
  const db = yield* Db;
  const blobId = uuidv7();
  yield* db.insert(attachmentBlobs).values({
    id: blobId,
    userId,
    sha256: blobId,
    storageKey: `test/${blobId}`,
    size: 4,
    mediaType: "image/png",
  });
  for (const file of files) {
    const attachmentId = uuidv7();
    yield* db.insert(attachments).values({
      id: attachmentId,
      userId,
      blobId,
      fileName: file.fileName,
      mediaType: "image/png",
    });
    yield* db
      .insert(messageAttachments)
      .values({ messageId, attachmentId, position: file.position });
  }
  return { blobId, storageKey: `test/${blobId}` };
});

const conversationIds = Effect.fn("test.conversationIds")(function* (userId: string) {
  const repo = yield* ChatRepo;
  const page = yield* repo.listConversations({ userId, limit: 100 });
  return page.conversations.map((c) => c.id);
});

/** Wait for LISTEN and the local subscription before publishing. */
const listenFor = Effect.fn("test.listenFor")(function* (userId: string, count: number) {
  const bus = yield* SyncBus;
  const ready = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(
    bus.subscribe(userId).pipe(
      Stream.tap((event) =>
        event.type === "sync.ready" ? Deferred.succeed(ready, undefined) : Effect.void,
      ),
      Stream.filter((event) => event.type !== "sync.ready"),
      Stream.take(count),
      Stream.runCollect,
    ),
  );
  yield* Deferred.await(ready);
  return fiber;
});

const branch = Effect.fn("test.branch")(function* (
  userId: string,
  conversationId: string,
  messageId: string,
) {
  const chat = yield* ChatService;
  const repo = yield* ChatRepo;
  const { conversationId: branchId } = yield* chat.branchConversation({
    userId,
    conversationId,
    messageId,
  });
  return {
    conversation: yield* repo.getConversation(userId, branchId),
    messages: yield* repo.listMessages(branchId),
  };
});

describe("branching a conversation", () => {
  it("copies the prefix through the chosen answer and leaves the source alone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [
          { user: "u1", assistant: "a1" },
          { user: "u2", assistant: "a2" },
          { user: "u3", assistant: "a3" },
        ]);
        // The middle answer: everything after it must stay behind.
        const target = source.messages[3]!;

        const forked = yield* branch(userId, source.conversation.id, target.id);
        return {
          branchContents: forked.messages.map((m) => m.content),
          sourceContents: (yield* repo.listMessages(source.conversation.id)).map((m) => m.content),
        };
      }),
    );

    expect(result.branchContents).toEqual(["u1", "a1", "u2", "a2"]);
    expect(result.sourceContents).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  it("copies a deleted agent association as a tombstone rather than making a plain chat", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u", assistant: "a" }]);
        const db = yield* Db;
        yield* db.execute(
          `insert into conversation_agents (conversation_id,agent_id) values ('${source.conversation.id}',null)` as never,
        );
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        const repo = yield* ChatRepo;
        expect(yield* repo.getConversationDefaults(forked.conversation.id)).toEqual({
          mode: "chat",
          projectId: null,
          agent: { agentId: null },
          agentDrafts: [],
          scheduleDrafts: [],
          documents: [],
          workingFiles: [],
        });
        expect(forked.messages.map((message) => message.content)).toEqual(["u", "a"]);
        yield* db.execute(
          `delete from conversations where id = '${source.conversation.id}'` as never,
        );
        expect(yield* repo.getConversationDefaults(forked.conversation.id)).toEqual({
          mode: "chat",
          projectId: null,
          agent: { agentId: null },
          agentDrafts: [],
          scheduleDrafts: [],
          documents: [],
          workingFiles: [],
        });
      }),
    );
  });

  it("reproduces every message field and timestamp under fresh ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [
          { user: "u1", assistant: "a1" },
          { user: "u2", assistant: "a2" },
        ]);
        const forked = yield* branch(userId, source.conversation.id, source.messages[3]!.id);
        return {
          copied: forked.messages.map(shape),
          original: source.messages.map(shape),
          sharedIds: forked.messages.filter((m) => source.messages.some((s) => s.id === m.id))
            .length,
          conversationIds: [...new Set(forked.messages.map((m) => m.conversationId))],
          branchId: forked.conversation.id,
        };
      }),
    );

    expect(result.copied).toEqual(result.original);
    expect(result.sharedIds).toBe(0);
    expect(result.conversationIds).toEqual([result.branchId]);
  });

  it("carries the tool calls but not the stream chunks", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }]);
        const answer = source.messages[1]!;

        const callId = uuidv7();
        yield* repo.insertToolCall({
          id: callId,
          messageId: answer.id,
          turnIndex: 1,
          callIndex: 2,
          providerCallId: "call_abc",
          toolName: "web_search",
          arguments: { query: "effect 4" },
        });
        yield* repo.completeToolCall({
          id: callId,
          status: "complete",
          result: { sources: [{ url: "https://example.com", title: "Example", status: "ok" }] },
        });
        yield* repo.appendChunks(answer.id, [{ seq: 1, kind: "text", delta: "a1" }]);

        const forked = yield* branch(userId, source.conversation.id, answer.id);
        const clonedAnswer = forked.messages[1]!;
        const cloned = yield* repo.listToolCalls([clonedAnswer.id]);
        const original = yield* repo.listToolCalls([answer.id]);
        return {
          cloned,
          original,
          clonedChunks: yield* repo.chunksAfter(clonedAnswer.id, 0),
          sourceChunks: yield* repo.chunksAfter(answer.id, 0),
        };
      }),
    );

    expect(result.cloned).toHaveLength(1);
    const cloned = result.cloned[0]!;
    const original = result.original[0]!;
    expect(cloned.id).not.toBe(original.id);
    expect(cloned.messageId).not.toBe(original.messageId);
    expect({
      turnIndex: cloned.turnIndex,
      callIndex: cloned.callIndex,
      providerCallId: cloned.providerCallId,
      toolName: cloned.toolName,
      arguments: cloned.arguments,
      result: cloned.result,
      status: cloned.status,
    }).toEqual({
      turnIndex: 1,
      callIndex: 2,
      providerCallId: "call_abc",
      toolName: "web_search",
      arguments: { query: "effect 4" },
      result: { sources: [{ url: "https://example.com", title: "Example", status: "ok" }] },
      status: "complete",
    });
    // Chunks only exist so a live stream can be resumed; nothing here is live.
    expect(result.clonedChunks).toEqual([]);
    expect(result.sourceChunks).toHaveLength(1);
  });

  it("clones attachment rows onto the copy despite the one-claim-per-row rule", async () => {
    const result = await run(
      Effect.gen(function* () {
        const attachmentRepo = yield* AttachmentRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "look at these", assistant: "a1" }]);
        const question = source.messages[0]!;
        const { blobId } = yield* attach(userId, question.id, [
          { fileName: "one.png", position: 0 },
          { fileName: "two.png", position: 1 },
        ]);

        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        const clonedQuestion = forked.messages[0]!;
        return {
          blobId,
          cloned: yield* attachmentRepo.listWithBlobsForMessages([clonedQuestion.id]),
          original: yield* attachmentRepo.listWithBlobsForMessages([question.id]),
        };
      }),
    );

    expect(result.cloned.map((a) => [a.fileName, a.position])).toEqual([
      ["one.png", 0],
      ["two.png", 1],
    ]);
    // Same bytes, new rows: message_attachments.attachment_id is unique, so a
    // clone can never reuse the attachment row the source already claimed.
    expect(result.cloned.every((a) => a.blobId === result.blobId)).toBe(true);
    expect(result.cloned.filter((a) => result.original.some((o) => o.id === a.id))).toEqual([]);
  });

  it("points copied publish and custom tool rows at the branch's files and copies no kept draft", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const attachmentRepo = yield* AttachmentRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "make a deck", assistant: "Done." }]);
        const answer = source.messages[1]!;
        const { blobId } = yield* attach(userId, answer.id, [
          { fileName: "deck.pptx", position: 0 },
          { fileName: "export.csv", position: 1 },
          { fileName: "totals.csv", position: 2 },
        ]);
        const delivered = yield* attachmentRepo.listWithBlobsForMessages([answer.id]);
        const idOf = (name: string) => delivered.find((file) => file.fileName === name)!.id;
        let callIndex = 0;
        const call = (toolName: string, toolResult: JsonValue) =>
          Effect.gen(function* () {
            const id = uuidv7();
            yield* repo.insertToolCall({
              id,
              messageId: answer.id,
              turnIndex: 0,
              callIndex: callIndex++,
              providerCallId: id,
              toolName,
              arguments: {},
            });
            yield* repo.completeToolCall({ id, status: "complete", result: toolResult });
          });
        const workingFileId = uuidv7();
        yield* call("publish_file", {
          ok: true,
          ref: `working:${workingFileId}@2`,
          workingFileId,
          attachmentId: idOf("deck.pptx"),
        });
        yield* call("create_file", { ok: true, attachmentId: idOf("totals.csv") });
        yield* call("custom_exporter__csv", {
          family: "custom",
          version: 1,
          name: "custom_exporter__csv",
          displayName: "CSV export",
          status: "complete",
          fileIds: [idOf("export.csv")],
        });
        // A draft the answer left unpublished: the source chat's alone.
        const keptAttachment = uuidv7();
        yield* db.insert(attachments).values({
          id: keptAttachment,
          userId,
          blobId,
          fileName: "draft.pptx",
          mediaType: "image/png",
        });
        yield* db.insert(conversationWorkingFiles).values({
          workingFileId: uuidv7(),
          messageId: answer.id,
          conversationId: source.conversation.id,
          attachmentId: keptAttachment,
          name: "draft.pptx",
          mediaType: "application/octet-stream",
          owner: "presentation",
          revision: 2,
          fingerprint: "0".repeat(64),
        });

        const forked = yield* branch(userId, source.conversation.id, answer.id);
        const clonedAnswer = forked.messages[1]!;
        return {
          calls: yield* repo.listToolCalls([clonedAnswer.id]),
          files: yield* attachmentRepo.listWithBlobsForMessages([clonedAnswer.id]),
          kept: yield* db
            .select()
            .from(conversationWorkingFiles)
            .where(eq(conversationWorkingFiles.conversationId, forked.conversation.id)),
          defaults: yield* repo.getConversationDefaults(forked.conversation.id),
          original: delivered.map((file) => file.id),
        };
      }),
    );
    const copyOf = (name: string) => result.files.find((file) => file.fileName === name)!.id;
    expect(result.original).not.toContain(copyOf("deck.pptx"));
    // The file card groups under its publish step by attachment id, in the branch too.
    expect(result.calls.find((row) => row.toolName === "publish_file")?.result).toMatchObject({
      ok: true,
      attachmentId: copyOf("deck.pptx"),
    });
    expect(result.calls.find((row) => row.toolName === "create_file")?.result).toEqual({
      ok: true,
      attachmentId: copyOf("totals.csv"),
    });
    expect(
      result.calls.find((row) => row.toolName === "custom_exporter__csv")?.result,
    ).toMatchObject({ fileIds: [copyOf("export.csv")] });
    expect(result.kept).toEqual([]);
    expect(result.defaults.workingFiles).toEqual([]);
  });

  it("flattens file aliases for a shorter branch after its source was deleted", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [
          { user: "earlier upload", assistant: "first answer" },
          { user: "later upload", assistant: "later answer" },
        ]);
        expect(source.conversation.fileReferenceAliases).toBeNull();
        yield* attach(userId, source.messages[0]!.id, [{ fileName: "early.png", position: 0 }]);
        yield* attach(userId, source.messages[2]!.id, [{ fileName: "late.png", position: 0 }]);
        const [early, late] = yield* attachmentRepo.listForMessages(
          source.messages.map((m) => m.id),
        );
        const content = `[earlier upload](/api/files/${early!.id})`;
        const replay = {
          v: 1 as const,
          turns: [
            {
              turnIndex: 0,
              startOffset: 0,
              endOffset: content.length,
              unit: {
                v: 1 as const,
                id: "unit-1",
                identity: {
                  provider: providerId,
                  baseUrl: "https://provider.test/v1",
                  format: "chat-completions" as const,
                  model: "m",
                },
                format: "chat-completions" as const,
                reasoningDetails: [{ type: "reasoning.encrypted", data: "signed-private-data" }],
              },
            },
          ],
        };
        yield* db
          .update(messages)
          .set({ content, providerReplay: replay })
          .where(eq(messages.id, source.messages[1]!.id));
        const callId = uuidv7();
        yield* repo.insertToolCall({
          id: callId,
          messageId: source.messages[1]!.id,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "reference-call",
          toolName: "custom_files__read",
          arguments: { attachmentId: early!.id },
        });
        yield* repo.completeToolCall({
          id: callId,
          status: "complete",
          result: { attachmentId: early!.id, text: content },
        });
        const originalCalls = yield* repo.listToolCalls([source.messages[1]!.id]);
        const first = yield* branch(userId, source.conversation.id, source.messages[3]!.id);
        const firstAliases = first.conversation.fileReferenceAliases!;
        expect(Object.keys(firstAliases.attachments).toSorted()).toEqual(
          [early!.id, late!.id].toSorted(),
        );
        expect(firstAliases.workspaceAncestors).toEqual([source.conversation.id]);
        yield* purgeConversation(userId, source.conversation.id);
        expect(
          (yield* repo.getConversation(userId, first.conversation.id)).branchedFrom,
        ).toBeNull();
        const second = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: first.conversation.id,
          throughMessageId: first.messages[1]!.id,
        });
        const secondMessages = yield* repo.listMessages(second.id);
        const secondFiles = yield* attachmentRepo.listForMessages(secondMessages.map((m) => m.id));
        expect(secondFiles).toHaveLength(1);
        const expected = {
          attachments: {
            [early!.id]: secondFiles[0]!.id,
            [firstAliases.attachments[early!.id]!]: secondFiles[0]!.id,
          },
          workspaceAncestors: [first.conversation.id, source.conversation.id],
        };
        expect(second.fileReferenceAliases).toEqual(expected);
        expect(secondMessages[1]).toMatchObject({ content, providerReplay: replay });
        const secondCalls = yield* repo.listToolCalls([secondMessages[1]!.id]);
        expect(secondCalls[0]).toMatchObject({
          arguments: originalCalls[0]!.arguments,
          result: originalCalls[0]!.result,
          turnIndex: originalCalls[0]!.turnIndex,
          callIndex: originalCalls[0]!.callIndex,
          textOffset: originalCalls[0]!.textOffset,
        });
        yield* purgeConversation(userId, first.conversation.id);
        const surviving = yield* repo.getConversation(userId, second.id);
        expect(surviving.branchedFrom).toBeNull();
        expect(surviving.fileReferenceAliases).toEqual(expected);
        expect(yield* attachmentRepo.listForConversation(userId, second.id)).toEqual(
          secondFiles.map(({ messageId: _messageId, position: _position, ...file }) => file),
        );
      }),
    );
  });

  it("rolls the entire branch back when inherited aliases collide", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "upload", assistant: "answer" }]);
        yield* attach(userId, source.messages[0]!.id, [
          { fileName: "one.png", position: 0 },
          { fileName: "two.png", position: 1 },
        ]);
        const files = yield* attachmentRepo.listForMessages([source.messages[0]!.id]);
        yield* db
          .update(conversationsTable)
          .set({
            fileReferenceAliases: {
              attachments: { [files[0]!.id]: files[1]!.id },
              workspaceAncestors: [],
            },
          })
          .where(eq(conversationsTable.id, source.conversation.id));
        const outcome = yield* Effect.exit(
          repo.cloneConversationPrefix({
            userId,
            sourceConversationId: source.conversation.id,
            throughMessageId: source.messages[1]!.id,
          }),
        );
        expect(outcome).toMatchObject({ _tag: "Failure" });
        expect(yield* conversationIds(userId)).toEqual([source.conversation.id]);
        expect(
          yield* db.select().from(attachments).where(eq(attachments.userId, userId)),
        ).toHaveLength(2);
      }),
    );
  });

  it("keeps the shared blob until the last conversation referencing it is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "here", assistant: "a1" }]);
        const { blobId, storageKey } = yield* attach(userId, source.messages[0]!.id, [
          { fileName: "one.png", position: 0 },
        ]);
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);

        const blobRows = () =>
          db.select().from(attachmentBlobs).where(eq(attachmentBlobs.id, blobId));

        const afterBranchDelete = yield* purgeConversation(userId, forked.conversation.id);
        const survives = (yield* blobRows()).length;
        const afterSourceDelete = yield* purgeConversation(userId, source.conversation.id);
        return {
          afterBranchDelete,
          survives,
          afterSourceDelete,
          remaining: (yield* blobRows()).length,
          storageKey,
        };
      }),
    );

    // The source still points at the bytes, so nothing to remove from storage.
    expect(result.afterBranchDelete).toEqual([]);
    expect(result.survives).toBe(1);
    expect(result.afterSourceDelete).toEqual([result.storageKey]);
    expect(result.remaining).toBe(0);
  });

  it("records the immediate parent and copies a title that already resolved", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const source = yield* seedThread(
          userId,
          [
            { user: "u1", assistant: "a1" },
            { user: "u2", assistant: "a2" },
          ],
          { title: "Root chat" },
        );
        const first = yield* branch(userId, source.conversation.id, source.messages[3]!.id);
        // Forking the fork: lineage points one step up, not at the root.
        const second = yield* branch(userId, first.conversation.id, first.messages[1]!.id);
        return {
          firstParent: first.conversation.branchedFrom,
          firstTitle: first.conversation.title,
          secondParent: second.conversation.branchedFrom,
          secondContents: second.messages.map((m) => m.content),
          sourceId: source.conversation.id,
          firstId: first.conversation.id,
        };
      }),
    );

    expect(result.firstParent).toBe(result.sourceId);
    expect(result.firstTitle).toBe("Root chat");
    expect(result.secondParent).toBe(result.firstId);
    expect(result.secondContents).toEqual(["u1", "a1"]);
  });

  it("puts the fresh branch at the top of the conversation list", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }], {
          title: "Root chat",
        });
        // Age the source so ordering cannot be an artifact of insert order.
        yield* db
          .update(conversationsTable)
          .set({ createdAt: new Date(BASE), lastMessageAt: new Date(BASE + 60_000) })
          .where(eq(conversationsTable.id, source.conversation.id));

        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        return { ids: yield* conversationIds(userId), branchId: forked.conversation.id };
      }),
    );

    expect(result.ids[0]).toBe(result.branchId);
    expect(result.ids).toHaveLength(2);
  });

  it("refuses another user's conversation and a message from elsewhere", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const owner = yield* makeUser();
        const stranger = yield* makeUser();
        const source = yield* seedThread(owner, [{ user: "u1", assistant: "a1" }]);
        const other = yield* seedThread(owner, [{ user: "x1", assistant: "y1" }]);

        const foreignConversation = yield* Effect.flip(
          chat.branchConversation({
            userId: stranger,
            conversationId: source.conversation.id,
            messageId: source.messages[1]!.id,
          }),
        );
        // A real, finished assistant message, just not in this conversation.
        const foreignMessage = yield* Effect.flip(
          chat.branchConversation({
            userId: owner,
            conversationId: source.conversation.id,
            messageId: other.messages[1]!.id,
          }),
        );
        return {
          foreignConversation: foreignConversation._tag,
          foreignMessage: foreignMessage._tag,
          ownerConversations: (yield* conversationIds(owner)).length,
          strangerConversations: (yield* conversationIds(stranger)).length,
        };
      }),
    );

    expect(result.foreignConversation).toBe("ConversationNotFound");
    expect(result.foreignMessage).toBe("MessageNotFound");
    expect(result.ownerConversations).toBe(2);
    expect(result.strangerConversations).toBe(0);
  });

  it("refuses a user message and an answer that is still generating", async () => {
    const result = await run(
      Effect.gen(function* () {
        const chat = yield* ChatService;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [
          { user: "u1", assistant: "a1" },
          { user: "u2", assistant: null },
        ]);

        const onUser = yield* Effect.flip(
          chat.branchConversation({
            userId,
            conversationId: source.conversation.id,
            messageId: source.messages[0]!.id,
          }),
        );
        const onStreaming = yield* Effect.flip(
          chat.branchConversation({
            userId,
            conversationId: source.conversation.id,
            messageId: source.messages[3]!.id,
          }),
        );
        return {
          onUser: { tag: onUser._tag, reason: (onUser as { reason?: string }).reason },
          onStreaming: {
            tag: onStreaming._tag,
            reason: (onStreaming as { reason?: string }).reason,
          },
          conversations: (yield* conversationIds(userId)).length,
        };
      }),
    );

    expect(result.onUser).toEqual({
      tag: "BranchNotAllowed",
      reason: "only assistant messages can be branched from",
    });
    expect(result.onStreaming).toEqual({
      tag: "BranchNotAllowed",
      reason: "message is still generating",
    });
    expect(result.conversations).toBe(1);
  });

  it("keeps the branch when its source is deleted, dropping only the lineage", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }], {
          title: "Root chat",
        });
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);

        yield* purgeConversation(userId, source.conversation.id);
        const after = yield* repo.getConversation(userId, forked.conversation.id);
        return {
          branchedFrom: after.branchedFrom,
          messages: (yield* repo.listMessages(after.id)).map((m) => m.content),
        };
      }),
    );

    expect(result.branchedFrom).toBeNull();
    expect(result.messages).toEqual(["u1", "a1"]);
  });

  it("gives a branch of a still-untitled chat its own generated title", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [
          { user: "how do I fork a chat?", assistant: "a1" },
        ]);
        yield* attach(userId, source.messages[0]!.id, [{ fileName: "notes.pdf", position: 0 }]);

        const events = yield* listenFor(userId, 2);
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        const collected = Array.from(yield* Fiber.join(events).pipe(Effect.timeout("10 seconds")));
        return {
          branchId: forked.conversation.id,
          atBranchTime: forked.conversation.title,
          resolved: (yield* repo.getConversation(userId, forked.conversation.id)).title,
          sourceTitle: (yield* repo.getConversation(userId, source.conversation.id)).title,
          events: collected,
        };
      }),
    );

    // The copy starts as pending as its source, then resolves on its own.
    expect(result.atBranchTime).toBeNull();
    expect(result.resolved).toBe(GENERATED_TITLE);
    // The source's own title fiber only ever writes to the source.
    expect(result.sourceTitle).toBeNull();
    expect(result.events).toEqual([
      { type: "conversation.created", conversationId: result.branchId },
      { type: "conversation.updated", conversationId: result.branchId },
    ]);
  });

  it("falls back to the first message when the model behind it is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const doomedModelId = uuidv7();
        yield* db.insert(models).values({
          id: doomedModelId,
          providerId,
          modelKey: "doomed",
          displayName: "Doomed",
          type: "chat",
        });
        const source = yield* seedThread(
          userId,
          [{ user: "  what is a keyset cursor?  ", assistant: "a1" }],
          { model: doomedModelId },
        );
        // FK is `on delete set null`: the answer survives, its model does not.
        yield* db.delete(models).where(eq(models.id, doomedModelId));

        const events = yield* listenFor(userId, 2);
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        const collected = Array.from(yield* Fiber.join(events).pipe(Effect.timeout("10 seconds")));
        return {
          branchId: forked.conversation.id,
          resolved: (yield* repo.getConversation(userId, forked.conversation.id)).title,
          events: collected,
        };
      }),
    );

    // There is no model left to ask, so the branch settles rather than hanging
    // on the placeholder forever.
    expect(result.resolved).toBe("what is a keyset cursor?");
    expect(result.events).toEqual([
      { type: "conversation.created", conversationId: result.branchId },
      { type: "conversation.updated", conversationId: result.branchId },
    ]);
  });
});

describe("temporary chats", () => {
  it("branches a temporary chat into another temporary chat", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }]);
        yield* db
          .update(conversationsTable)
          .set({ temporary: true })
          .where(eq(conversationsTable.id, source.conversation.id));
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);
        return { temporary: forked.conversation.temporary, listed: yield* conversationIds(userId) };
      }),
    );
    expect(result).toEqual({ temporary: true, listed: [] });
  });

  it("sweeps an expired temporary chat and tells its owner's tabs", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const chat = yield* ChatService;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }]);
        const long = new Date(Date.now() - 25 * 60 * 60 * 1000);
        yield* db
          .update(conversationsTable)
          .set({ temporary: true, createdAt: long, lastMessageAt: long })
          .where(eq(conversationsTable.id, source.conversation.id));
        const events = yield* listenFor(userId, 1);
        yield* chat.sweepExpired();
        const remaining = yield* db
          .select({ id: conversationsTable.id })
          .from(conversationsTable)
          .where(eq(conversationsTable.id, source.conversation.id));
        return {
          id: source.conversation.id,
          remaining,
          events: Array.from(yield* Fiber.join(events)),
        };
      }),
    );
    expect(result.remaining).toEqual([]);
    expect(result.events).toEqual([{ type: "conversation.purged", conversationId: result.id }]);
  });
});

describe("deleted chats", () => {
  it("can be undone until the sweep purges them, and every tab hears each step", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const chat = yield* ChatService;
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "u1", assistant: "a1" }]);
        const id = source.conversation.id;
        const events = yield* listenFor(userId, 4);
        const firstMark = yield* chat.deleteConversation({ userId, conversationId: id });
        // Inside the grace period the sweep leaves it alone.
        yield* chat.sweepExpired();
        const restored = yield* chat.restoreConversation({
          userId,
          conversationId: id,
          mark: firstMark!,
        });
        const messagesBack = (yield* repo.listMessages(id)).length;
        yield* chat.deleteConversation({ userId, conversationId: id });
        const mark = yield* outlastGrace(id);
        yield* chat.sweepExpired();
        const restoredAfterPurge = yield* chat.restoreConversation({
          userId,
          conversationId: id,
          mark,
        });
        const remaining = yield* db
          .select({ id: conversationsTable.id })
          .from(conversationsTable)
          .where(eq(conversationsTable.id, id));
        return {
          id,
          restored,
          messagesBack,
          restoredAfterPurge,
          remaining,
          events: Array.from(yield* Fiber.join(events)),
        };
      }),
    );
    expect(result).toMatchObject({
      restored: true,
      messagesBack: 2,
      restoredAfterPurge: false,
      remaining: [],
    });
    expect(result.events).toEqual(
      [
        "conversation.deleted",
        "conversation.updated",
        "conversation.deleted",
        "conversation.purged",
      ].map((type) => ({ type, conversationId: result.id })),
    );
  });
});

describe("saved ui block state", () => {
  const BLOCK = "<script>let n = $state(0);</script><text>{n}</text>";
  const ANSWER = `Here:\n\n\`\`\`ui\n${BLOCK}\n\`\`\`\n`;

  const seedAnswer = Effect.fn("test.seedUiAnswer")(function* () {
    const userId = yield* makeUser();
    const { conversation, messages: rows } = yield* seedThread(userId, [
      { user: "Show me a counter", assistant: ANSWER },
    ]);
    const assistant = rows.find((m) => m.role === "assistant")!;
    return { userId, conversation, assistant, rows };
  });

  it("accepts only the owner's save of the current attempt's stored block, and a branch keeps it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* seedAnswer();
        const stranger = yield* makeUser();
        const base = {
          userId,
          messageId: assistant.id,
          generationId: assistant.generationId!,
          ordinal: 0,
          sourceHash: hashSource(BLOCK),
          state: { n: 3 },
        };
        const outcomes = {
          stranger: yield* repo.saveUiState({ ...base, userId: stranger }),
          replacedAttempt: yield* repo.saveUiState({ ...base, generationId: uuidv7() }),
          otherSource: yield* repo.saveUiState({
            ...base,
            sourceHash: hashSource("<text>x</text>"),
          }),
          missingBlock: yield* repo.saveUiState({ ...base, ordinal: 1 }),
          saved: yield* repo.saveUiState(base),
          overwritten: yield* repo.saveUiState({ ...base, state: { n: 4 } }),
        };
        const stored = yield* repo.listUiStates([assistant.id]);
        const branched = yield* branch(userId, conversation.id, assistant.id);
        const copy = branched.messages.find((m) => m.role === "assistant")!;
        const copied = yield* repo.listUiStates([copy.id]);
        // The copy has no attempt of its own, and the reader keeps using its blocks.
        const copySave = { ...base, messageId: copy.id, generationId: null, state: { n: 5 } };
        const inCopy = {
          generationId: copy.generationId,
          saved: yield* repo.saveUiState(copySave),
          wrongAttempt: yield* repo.saveUiState({ ...copySave, generationId: uuidv7() }),
          rows: yield* repo.listUiStates([copy.id]),
        };
        return { outcomes, stored, copied, inCopy };
      }),
    );
    expect(result.inCopy.generationId).toBeNull();
    expect(result.inCopy.saved).toBe("saved");
    expect(result.inCopy.wrongAttempt).toBe("refused");
    expect(result.inCopy.rows.map((row) => row.state)).toEqual([{ n: 5 }]);
    expect(result.outcomes).toEqual({
      stranger: "refused",
      replacedAttempt: "refused",
      otherSource: "refused",
      missingBlock: "refused",
      saved: "saved",
      overwritten: "saved",
    });
    expect(result.stored.map((row) => row.state)).toEqual([{ n: 4 }]);
    expect(result.copied.map((row) => [row.ordinal, row.sourceHash, row.state])).toEqual([
      [0, hashSource(BLOCK), { n: 4 }],
    ]);
  });

  it("drops saved state when a retry starts a new attempt, and refuses the old attempt's late save", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const { userId, conversation, assistant } = yield* seedAnswer();
        const save = {
          userId,
          messageId: assistant.id,
          generationId: assistant.generationId!,
          ordinal: 0,
          sourceHash: hashSource(BLOCK),
          state: { n: 3 },
        };
        yield* repo.saveUiState(save);
        yield* repo.resetMessageForRetry({
          expectedMessages: yield* repo.listMessages(conversation.id),
          userId,
          messageId: assistant.id,
          modelId,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
        });
        const afterReset = yield* repo.listUiStates([assistant.id]);
        yield* repo.finalizeMessage({
          messageId: assistant.id,
          status: "complete",
          content: ANSWER,
        });
        const late = yield* repo.saveUiState(save);
        return { afterReset, late, final: yield* repo.listUiStates([assistant.id]) };
      }),
    );
    expect(result.afterReset).toEqual([]);
    // Same source, but the old attempt's id: the retry's answer owns its blocks.
    expect(result.late).toBe("refused");
    expect(result.final).toEqual([]);
  });
});
