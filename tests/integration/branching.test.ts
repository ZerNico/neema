import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  attachments,
  conversations as conversationsTable,
  messageAttachments,
  messages,
  models,
} from "~/db/schema/index.ts";
import { Response as AiResponse } from "effect/unstable/ai";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo, type MessageRow } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import {
  FakeBlobStore,
  FakeDocumentParser,
  FakeWebSearch,
  FakeUrlReader,
} from "./unused-services.ts";
import { Db } from "~/server/db.ts";
import { FakeMemoryService } from "./fake-memory.ts";

// ProviderRepo decrypts stored keys through KeyCipher, which reads this.
process.env.PROVIDER_KEY_SECRET ??= Buffer.alloc(32, 7).toString("base64");

let container: StartedPostgreSqlContainer;
type Services = ChatRepo | ChatService | AttachmentRepo | SyncBus | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
/** messages.model_id / conversations.model_id are real FKs. */
let modelId: string;
let providerId: string;

// Only titles are generated here — nothing in this file streams an answer.
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
  generateText: () => fakeGeneratedText(GENERATED_TITLE),
  streamChat: () => Stream.fromEffect(Effect.die("no generation in these tests")),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
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
        FakeMemoryService,
        SyncBus.layer,
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
        `insert into providers (id, name, kind, base_url, api_key_ciphertext)
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

/** Everything but identity — what a clone has to reproduce exactly. */
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
    yield* db
      .insert(attachments)
      .values({ id: attachmentId, userId, blobId, fileName: file.fileName });
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

/**
 * Sync events are a NOTIFY roundtrip, so the collector has to be listening
 * before the action that publishes — hence the fork + settle.
 */
const listenFor = Effect.fn("test.listenFor")(function* (userId: string, count: number) {
  const bus = yield* SyncBus;
  const fiber = yield* Effect.forkChild(
    bus.subscribe(userId).pipe(Stream.take(count), Stream.runCollect),
  );
  yield* Effect.sleep("200 millis");
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

  it("keeps the shared blob until the last conversation referencing it is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const db = yield* Db;
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, [{ user: "here", assistant: "a1" }]);
        const { blobId, storageKey } = yield* attach(userId, source.messages[0]!.id, [
          { fileName: "one.png", position: 0 },
        ]);
        const forked = yield* branch(userId, source.conversation.id, source.messages[1]!.id);

        const blobRows = () =>
          db.select().from(attachmentBlobs).where(eq(attachmentBlobs.id, blobId));

        const afterBranchDelete = yield* repo.deleteConversation(userId, forked.conversation.id);
        const survives = (yield* blobRows()).length;
        const afterSourceDelete = yield* repo.deleteConversation(userId, source.conversation.id);
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
        // A real, finished assistant message — just not in this conversation.
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

        yield* repo.deleteConversation(userId, source.conversation.id);
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
