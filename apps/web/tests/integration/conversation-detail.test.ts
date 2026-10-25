import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq, inArray } from "drizzle-orm";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  attachments,
  conversationQueueEntries,
  conversationQueueEntryAttachments,
  conversations,
  documents,
  messageAttachments,
  messageChunks,
  messageGenerationConfig,
  messageToolCalls,
  messages,
  models,
} from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import {
  HEAD_TURNS,
  OLDER_TURNS,
  loadConversationDetail,
  loadConversationHistory,
} from "~/modules/chat/server/conversation-detail.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";
import { purgeConversation } from "./purge.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
type Services = ChatRepo | AttachmentRepo | AgentRepo | ScheduleRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
/** conversations.model_id / messages.model_id are real FKs. */
let modelId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  // Only what the detail read touches: no gateway, no stream engine, no
  // services, so this exercises the payload assembly against real SQL.
  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ChatRepo.layer.pipe(Layer.provideMerge(AttachmentRepo.layer)),
      AgentRepo.layer,
      ScheduleRepo.layer,
    ).pipe(Layer.provideMerge(InfraLayer)),
  );

  modelId = uuidv7();
  const providerId = uuidv7();
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
  yield* db.execute(
    `insert into user_approvals (user_id, status) values ('${userId}', 'approved')` as never,
  );
  return userId;
});

/** A titled conversation with one finished turn. */
const seedThread = Effect.fn("test.seedThread")(function* (userId: string, title: string) {
  const repo = yield* ChatRepo;
  const conversation = yield* repo.createConversation({ userId, modelId });
  yield* repo.updateConversation(conversation.id, { title });
  const user = yield* repo.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hello",
  });
  const assistant = yield* repo.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    status: "streaming",
    modelId,
  });
  yield* repo.finalizeMessage({ messageId: assistant.id, status: "complete", content: "hi" });
  return { conversationId: conversation.id, userMessageId: user.id, assistantId: assistant.id };
});

/** An agent turn that ran with the agent's `agent-c` and the person's `own-c`. */
const configureCollections = Effect.fn("test.configureCollections")(function* (
  assistantId: string,
  standalone: ReadonlyArray<string>,
) {
  const db = yield* Db;
  const agent = JSON.stringify({
    agentId: uuidv7(),
    configRevision: 1,
    name: "Agent",
    icon: "robot",
    instructions: "",
    collectionIds: ["agent-c"],
    searchEnabled: false,
    planEnabled: false,
  });
  yield* db.execute(
    `update message_generation_config set resolved_agent = '${agent}'::jsonb, collection_ids = '["agent-c","own-c"]'::jsonb, standalone_collection_ids = '${JSON.stringify(standalone)}'::jsonb where message_id = '${assistantId}'` as never,
  );
});

/**
 * Points a conversation at a source directly. Branching only ever links two
 * conversations of the same owner, so the cross-owner case has to be written
 * in: the foreign key does not constrain it, and the read must not leak.
 */
const linkBranch = Effect.fn("test.linkBranch")(function* (
  conversationId: string,
  sourceId: string,
) {
  const db = yield* Db;
  yield* db
    .update(conversations)
    .set({ branchedFrom: sourceId })
    .where(eq(conversations.id, conversationId));
});

describe("attempt snapshot reads", () => {
  it.each(["detail", "history"] as const)(
    "rereads %s when retry replaces the captured attempt",
    async (kind) => {
      const result = await run(
        Effect.gen(function* () {
          const repo = yield* ChatRepo;
          const db = yield* Db;
          const userId = yield* makeUser();
          const thread = yield* seedThread(userId, "Retry race");
          const later = yield* repo.insertMessage({
            conversationId: thread.conversationId,
            role: "user",
            content: "Later",
          });
          const captured = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let reads = 0;
          // Pause after the real SELECT has returned, not before the snapshot exists.
          const observedRepo = {
            ...repo,
            listMessageWindow: (...args: Parameters<typeof repo.listMessageWindow>) =>
              Effect.gen(function* () {
                const rows = yield* repo.listMessageWindow(...args);
                reads += 1;
                if (reads === 1) {
                  yield* Deferred.succeed(captured, undefined);
                  yield* Deferred.await(release);
                }
                return rows;
              }),
          };
          const load = Effect.gen(function* () {
            if (kind === "detail")
              return yield* loadConversationDetail(userId, thread.conversationId);
            return yield* loadConversationHistory(userId, thread.conversationId, later.id);
          });
          const pending = yield* Effect.forkChild(
            load.pipe(Effect.provideService(ChatRepo, observedRepo)),
          );
          yield* Deferred.await(captured);
          const oldGeneration = (yield* repo.getMessage(thread.assistantId))!.generationId;
          const retried = yield* repo.resetMessageForRetry({
            userId,
            messageId: thread.assistantId,
            modelId,
            expectedMessages: yield* repo.listMessages(thread.conversationId),
            deleteMessageIds: [later.id],
            invalidateCheckpointThroughMessageIds: [],
          });
          const current = (yield* repo.getMessage(thread.assistantId))!;
          yield* db
            .insert(messageChunks)
            .values({ messageId: current.id, seq: 1, kind: "text", delta: "New attempt" });
          yield* repo.insertToolCall({
            id: uuidv7(),
            messageId: current.id,
            turnIndex: 0,
            callIndex: 0,
            providerCallId: "new-call",
            toolName: "web_search",
            arguments: { queries: ["new"] },
          });
          yield* Deferred.succeed(release, undefined);
          const loaded = yield* Fiber.join(pending);
          return { retried, oldGeneration, current, loaded, reads };
        }),
      );
      expect(result.retried.claimed).toBe(true);
      expect(result.current.generationId).not.toBe(result.oldGeneration);
      expect(result.reads).toBeGreaterThanOrEqual(4);
      if ("pendingChunks" in result.loaded) {
        expect(
          result.loaded.messages.find((message) => message.role === "assistant"),
        ).toMatchObject({
          generationId: result.current.generationId,
          status: "streaming",
          content: "",
        });
        expect(result.loaded.toolCalls).toHaveLength(1);
        expect(result.loaded.toolCalls[0]?.providerCallId).toBe("new-call");
        expect(result.loaded.pendingChunks).toMatchObject([{ seq: 1, delta: "New attempt" }]);
      } else {
        // Retry removed the history cursor too. Never return its former page with new rows.
        expect(result.loaded.messages).toEqual([]);
        expect(result.loaded.toolCalls).toEqual([]);
      }
    },
  );
});

describe("loadConversationDetail", () => {
  it("resolves the source of a branch", async () => {
    const userId = await run(makeUser());
    const source = await run(seedThread(userId, "Original thread"));
    const branch = await run(seedThread(userId, "Forked thread"));
    await run(linkBranch(branch.conversationId, source.conversationId));

    const detail = await run(loadConversationDetail(userId, branch.conversationId));

    expect(detail.branchedFrom).toEqual({
      conversationId: source.conversationId,
      title: "Original thread",
    });
    expect(detail.conversation.id).toBe(branch.conversationId);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("leaves lineage null when the source belongs to someone else", async () => {
    const owner = await run(makeUser());
    const stranger = await run(makeUser());
    const theirs = await run(seedThread(stranger, "Someone else's thread"));
    const branch = await run(seedThread(owner, "Forked thread"));
    await run(linkBranch(branch.conversationId, theirs.conversationId));

    const detail = await run(loadConversationDetail(owner, branch.conversationId));

    // The whole payload still loads: an unreadable source drops the marker,
    // it does not fail the read.
    expect(detail.branchedFrom).toBeNull();
    expect(detail.conversation.title).toBe("Forked thread");
    expect(detail.messages).toHaveLength(2);
  });

  it("has no lineage for a conversation that was never branched", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedThread(userId, "Plain thread"));

    const detail = await run(loadConversationDetail(userId, thread.conversationId));

    expect(detail.branchedFrom).toBeNull();
    expect(detail.conversation.fileReferenceAliases).toBeNull();
  });

  it("retains branch file provenance in detail after deleting the source", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const source = yield* seedThread(userId, "Source");
        const repo = yield* ChatRepo;
        const branch = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: source.conversationId,
          throughMessageId: source.assistantId,
        });
        yield* purgeConversation(userId, source.conversationId);
        const detail = yield* loadConversationDetail(userId, branch.id);
        expect(detail.branchedFrom).toBeNull();
        expect(detail.conversation.fileReferenceAliases).toEqual({
          attachments: {},
          workspaceAncestors: [source.conversationId],
        });
      }),
    );
  });

  it("projects conversation document summaries without their source", async () => {
    const privateSource = (text: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const userId = await run(makeUser());
    const thread = await run(seedThread(userId, "Document thread"));
    const firstId = uuidv7();
    const secondId = uuidv7();
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(documents).values([
          {
            id: secondId,
            conversationId: thread.conversationId,
            title: "Second",
            lastEditedBy: "model",
            snapshot: privateSource("PRIVATE SECOND SOURCE"),
          },
          {
            id: firstId,
            conversationId: thread.conversationId,
            title: "First",
            lastEditedBy: "user",
            snapshot: privateSource("PRIVATE FIRST SOURCE"),
          },
        ]),
      ),
    );

    const detail = await run(loadConversationDetail(userId, thread.conversationId));

    const expectedDocuments =
      firstId.localeCompare(secondId) < 0
        ? [
            { id: firstId, title: "First", messageId: null },
            { id: secondId, title: "Second", messageId: null },
          ]
        : [
            { id: secondId, title: "Second", messageId: null },
            { id: firstId, title: "First", messageId: null },
          ];
    expect(detail.documents).toEqual(expectedDocuments);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE FIRST SOURCE");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE SECOND SOURCE");
  });

  it("attaches generation activity to the assistant messages it belongs to", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedThread(userId, "Researched thread"));
    await run(
      ChatRepo.use((repo) =>
        repo.insertToolCall({
          id: uuidv7(),
          messageId: thread.assistantId,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "call-1",
          toolName: "web_search",
          arguments: { queries: ["effect 4"] },
        }),
      ),
    );

    const detail = await run(loadConversationDetail(userId, thread.conversationId));

    expect(detail.toolCalls).toHaveLength(1);
    expect(detail.toolCalls[0]?.messageId).toBe(thread.assistantId);
    expect(detail.compactionEvents).toEqual([]);
    expect(detail.attachments).toEqual([]);
    // Nothing is streaming, so there is nothing for the client to resume from.
    expect(detail.pendingChunks).toEqual([]);
  });

  it("gives an answer's saved file copy the image size recorded since", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedThread(userId, "Drawn thread"));
    const attachmentId = uuidv7();
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const blobId = uuidv7();
        yield* db.insert(attachmentBlobs).values({
          id: blobId,
          userId,
          sha256: blobId,
          storageKey: `private/${blobId}`,
          size: 4,
          mediaType: "image/png",
          width: 1536,
          height: 1024,
        });
        yield* db.insert(attachments).values({
          id: attachmentId,
          userId,
          blobId,
          fileName: "drawn.png",
          mediaType: "image/png",
        });
        yield* db
          .insert(messageAttachments)
          .values({ messageId: thread.assistantId, attachmentId, position: 0 });
        // A copy taken before sizes were recorded.
        yield* db
          .update(messages)
          .set({
            assistantOutput: {
              v: 1,
              files: [
                {
                  v: 1,
                  attachment: {
                    id: attachmentId,
                    fileName: "drawn.png",
                    size: 4,
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
          .where(eq(messages.id, thread.assistantId));
      }),
    );

    const detail = await run(loadConversationDetail(userId, thread.conversationId));

    const answer = detail.messages.find((message) => message.id === thread.assistantId);
    expect(answer?.assistantOutput?.files[0]?.attachment.dimensions).toEqual({
      width: 1536,
      height: 1024,
    });
  });

  it("keeps ordinary chat compaction summaries displayable", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedThread(userId, "Compacted thread"));
    await run(
      ChatRepo.use((repo) =>
        Effect.gen(function* () {
          const id = uuidv7();
          yield* repo.createCompactionEvent({
            id,
            messageId: thread.assistantId,
            beforeTurnIndex: 0,
            passIndex: 0,
            scope: "history",
          });
          yield* repo.completeCompactionEvent({
            id,
            status: "complete",
            outcome: "summary",
            summary: "The conversation concerned gardening.",
          });
        }),
      ),
    );
    const detail = await run(loadConversationDetail(userId, thread.conversationId));
    expect(detail.compactionEvents).toHaveLength(1);
    expect(detail.compactionEvents[0]?.summary).toBe("The conversation concerned gardening.");
  });

  it("loads assistant display metadata in one batch without full generation configs", async () => {
    const owner = await run(makeUser());
    const thread = await run(seedThread(owner, "Batched metadata"));
    await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const ids = [thread.assistantId];
        for (let n = 0; n < 8; n++)
          ids.push(
            (yield* repo.insertMessage({
              conversationId: thread.conversationId,
              role: "assistant",
              status: "complete",
              modelId,
            })).id,
          );
        let batches = 0;
        yield* loadConversationDetail(owner, thread.conversationId).pipe(
          Effect.provideService(ChatRepo, {
            ...repo,
            getGenerationConfig: () => Effect.die("Display must never read generation manifests"),
            listGenerationDisplay: (messageIds) => {
              batches++;
              expect(new Set(messageIds)).toEqual(new Set(ids));
              return repo.listGenerationDisplay(messageIds);
            },
          }),
        );
        expect(batches).toBe(1);
      }),
    );
  });

  it("projects live safe agent metadata and unavailable tombstones without exposing private execution records", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const ownerId = yield* makeUser();
        const thread = yield* seedThread(userId, "Agent chat");
        const db = yield* Db;
        const agentId = uuidv7();
        yield* db.execute(
          `insert into agents (id,user_id,name,instructions) values ('${agentId}','${ownerId}','Original','SECRET INSTRUCTIONS')` as never,
        );
        yield* db.execute(
          `insert into agent_user_grants (agent_id,user_id) values ('${agentId}','${userId}')` as never,
        );
        yield* db.execute(
          `insert into conversation_agents (conversation_id,agent_id) values ('${thread.conversationId}','${agentId}')` as never,
        );
        const first = yield* loadConversationDetail(userId, thread.conversationId);
        expect(first.agent).toMatchObject({ id: agentId, name: "Original", available: true });
        yield* db.execute(
          `update agents set name = 'Renamed', icon = 'code', instructions = 'NEW SECRET', config_revision = 2 where id = '${agentId}'` as never,
        );
        yield* db.execute(
          `insert into agent_collections (agent_id,collection_id,position) values ('${agentId}','unavailable-dependency',0)` as never,
        );
        const renamed = yield* loadConversationDetail(userId, thread.conversationId);
        expect(renamed.agent).toEqual({
          id: agentId,
          name: "Renamed",
          icon: "code",
          collectionIds: ["unavailable-dependency"],
          searchEnabled: false,
          imageModelId: null,
          available: true,
        });
        expect(JSON.stringify(renamed)).not.toContain("SECRET");
        expect(JSON.stringify(renamed)).not.toContain("resolvedAgent");
        yield* db.execute(`delete from agent_user_grants where agent_id = '${agentId}'` as never);
        const revoked = yield* loadConversationDetail(userId, thread.conversationId);
        expect(revoked.agent).toEqual({
          id: agentId,
          name: null,
          icon: "robot",
          collectionIds: [],
          searchEnabled: true,
          imageModelId: null,
          available: false,
        });
        expect(revoked.messages).toEqual(first.messages);
        yield* db.execute(`delete from agents where id = '${agentId}'` as never);
        const deleted = yield* loadConversationDetail(userId, thread.conversationId);
        expect(deleted.agent).toEqual({
          id: null,
          name: null,
          icon: "robot",
          collectionIds: [],
          searchEnabled: true,
          imageModelId: null,
          available: false,
        });
        expect(deleted.messages).toEqual(first.messages);
      }),
    );
  });

  it("shows a turn's own collections, never the ones its agent brought", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const thread = yield* seedThread(userId, "Agent chat");
        yield* configureCollections(thread.assistantId, ["own-c"]);
        const detail = yield* loadConversationDetail(userId, thread.conversationId);
        expect(detail.generations).toMatchObject([
          { messageId: thread.assistantId, collectionIds: ["own-c"] },
        ]);
      }),
    );
  });

  it("backfills the person's own collections on rows that recorded only the effective set", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const legacy = yield* seedThread(userId, "Legacy");
        yield* configureCollections(legacy.assistantId, []);
        // A pick the agent also brings is kept, though the question never shows it.
        const current = yield* seedThread(userId, "Current");
        yield* configureCollections(current.assistantId, ["agent-c", "own-c"]);
        const db = yield* Db;
        yield* db.execute(
          readFileSync(
            new URL(
              "../../drizzle/20261025113025_standalone_collections_backfill/migration.sql",
              import.meta.url,
            ),
            "utf8",
          ) as never,
        );
        const legacyDetail = yield* loadConversationDetail(userId, legacy.conversationId);
        expect(legacyDetail.generations).toMatchObject([{ collectionIds: ["own-c"] }]);
        const currentDetail = yield* loadConversationDetail(userId, current.conversationId);
        expect(currentDetail.generations).toMatchObject([{ collectionIds: ["own-c"] }]);
        const [stored] = yield* db
          .select({ ids: messageGenerationConfig.standaloneCollectionIds })
          .from(messageGenerationConfig)
          .where(eq(messageGenerationConfig.messageId, current.assistantId));
        expect(stored?.ids).toEqual(["agent-c", "own-c"]);
      }),
    );
  });

  it("fails before reading anything for a conversation the caller does not own", async () => {
    const owner = await run(makeUser());
    const stranger = await run(makeUser());
    const thread = await run(seedThread(owner, "Private thread"));

    const error = await run(Effect.flip(loadConversationDetail(stranger, thread.conversationId)));

    expect(error._tag).toBe("ConversationNotFound");
    expect(error.conversationId).toBe(thread.conversationId);
  });
});

/** `turns` finished turns in one new conversation, oldest first. */
const seedTurns = Effect.fn("test.seedTurns")(function* (userId: string, turns: number) {
  const repo = yield* ChatRepo;
  const conversation = yield* repo.createConversation({ userId, modelId });
  const rows: Array<{ userId: string; assistantId: string }> = [];
  for (let turn = 1; turn <= turns; turn += 1) rows.push(yield* addTurn(conversation.id, turn));
  return { conversationId: conversation.id, turns: rows };
});

const addTurn = Effect.fn("test.addTurn")(function* (
  conversationId: string,
  turn: number,
  answer = `answer ${turn}`,
) {
  const repo = yield* ChatRepo;
  const user = yield* repo.insertMessage({
    conversationId,
    role: "user",
    content: `question ${turn}`,
  });
  const assistant = yield* repo.insertMessage({
    conversationId,
    role: "assistant",
    status: "streaming",
    modelId,
  });
  yield* repo.finalizeMessage({ messageId: assistant.id, status: "complete", content: answer });
  return { userId: user.id, assistantId: assistant.id };
});

const source = (index: number) => ({
  kind: "web",
  index,
  url: `https://s${index}.dev`,
  title: `S${index}`,
  snippet: "",
  read: false,
});

describe("loadConversationDetail windows", () => {
  it("ships reference metadata for unloaded files, but not pending or unrelated files", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const stranger = yield* makeUser();
        const thread = yield* seedTurns(userId, HEAD_TURNS + 3);
        const other = yield* seedThread(userId, "Other conversation");
        const db = yield* Db;
        const attachmentRepo = yield* AttachmentRepo;
        const blobId = uuidv7();
        yield* db.insert(attachmentBlobs).values({
          id: blobId,
          userId,
          sha256: blobId,
          storageKey: `private/${blobId}`,
          size: 4,
          mediaType: "text/plain",
          parsedText: "PRIVATE PARSED TEXT",
        });
        const files = Array.from({ length: 6 }, (_, i) => ({
          id: uuidv7(),
          userId,
          blobId,
          fileName: `file-${i}.txt`,
          mediaType: "text/plain",
        }));
        yield* db.insert(attachments).values(files);
        const linkedMessages = [
          thread.turns[0]!.userId,
          thread.turns[0]!.assistantId,
          thread.turns.at(-1)!.userId,
          other.userMessageId,
        ];
        yield* db.insert(messageAttachments).values(
          linkedMessages.map((messageId, i) => ({
            messageId,
            attachmentId: files[i]!.id,
            position: 0,
          })),
        );
        yield* db
          .update(messages)
          .set({ steeredIntoMessageId: thread.turns.at(-1)!.assistantId })
          .where(eq(messages.id, thread.turns.at(-1)!.userId));
        const queueId = uuidv7();
        yield* db.insert(conversationQueueEntries).values({
          id: queueId,
          conversationId: thread.conversationId,
          userId,
          content: "pending",
          input: { modelId, searchEnabled: false, researchEnabled: false },
        });
        yield* db.insert(conversationQueueEntryAttachments).values({
          queueEntryId: queueId,
          attachmentId: files[4]!.id,
          position: 0,
        });
        const detail = yield* loadConversationDetail(userId, thread.conversationId);
        expect(detail.messages.some((message) => message.id === thread.turns[0]!.userId)).toBe(
          false,
        );
        expect(detail.attachments.map((file) => file.id)).toEqual([files[2]!.id]);
        const expected = files.slice(0, 3).map((file) => ({
          id: file.id,
          fileName: file.fileName,
          size: 4,
          mediaType: "text/plain",
          kind: "text",
        }));
        expect(detail.referenceAttachments).toEqual(expected);
        expect(yield* attachmentRepo.listForConversation(stranger, thread.conversationId)).toEqual(
          [],
        );
        const older = yield* loadConversationHistory(
          userId,
          thread.conversationId,
          detail.window.olderCursor!,
        );
        expect(older).not.toHaveProperty("referenceAttachments");
        const repo = yield* ChatRepo;
        const branch = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: thread.conversationId,
          throughMessageId: thread.turns[0]!.assistantId,
        });
        const branchDetail = yield* loadConversationDetail(userId, branch.id);
        expect(branchDetail.referenceAttachments.map((file) => file.id)).toEqual(
          files.slice(0, 2).map((file) => branch.fileReferenceAliases!.attachments[file.id]),
        );
        yield* db
          .delete(messageAttachments)
          .where(eq(messageAttachments.attachmentId, files[0]!.id));
        const refreshed = yield* loadConversationDetail(userId, thread.conversationId);
        expect(refreshed.referenceAttachments).toEqual(expected.slice(1));
      }),
    );
  });

  it("loads the latest turns, then pages back to the start without gaps or overlap", async () => {
    const userId = await run(makeUser());
    const turns = HEAD_TURNS + OLDER_TURNS + 10;
    const thread = await run(seedTurns(userId, turns));
    const all = (
      await run(Effect.flatMap(ChatRepo, (repo) => repo.listMessages(thread.conversationId)))
    ).map((m) => m.id);

    const head = await run(loadConversationDetail(userId, thread.conversationId));
    expect(head.messages).toHaveLength(HEAD_TURNS * 2);
    expect(head.window.anchorId).toBe(head.messages[0]!.id);
    expect(head.window.olderCursor).toBe(head.window.anchorId);

    const middle = await run(
      loadConversationHistory(userId, thread.conversationId, head.window.olderCursor!),
    );
    expect(middle.messages).toHaveLength(OLDER_TURNS * 2);
    const first = await run(
      loadConversationHistory(userId, thread.conversationId, middle.olderCursor!),
    );
    expect(first.olderCursor).toBeNull();

    expect([...first.messages, ...middle.messages, ...head.messages].map((m) => m.id)).toEqual(all);
  });

  it("grows from its anchor on refetch instead of sliding", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedTurns(userId, HEAD_TURNS + 5));
    const head = await run(loadConversationDetail(userId, thread.conversationId));

    await run(addTurn(thread.conversationId, HEAD_TURNS + 6));
    const again = await run(
      loadConversationDetail(userId, thread.conversationId, head.window.anchorId),
    );

    expect(again.window.anchorId).toBe(head.window.anchorId);
    expect(again.messages).toHaveLength(HEAD_TURNS * 2 + 2);
    expect(again.messages.at(-1)!.content).toBe(`answer ${HEAD_TURNS + 6}`);
  });

  it("never opens a window on a steer or on a question's reply", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedTurns(userId, HEAD_TURNS + 2));
    // Without these, turn 3 would open the latest HEAD_TURNS turns.
    const [, second, third, fourth] = thread.turns;
    await run(
      Effect.flatMap(Db, (db) =>
        Effect.all([
          db
            .update(messages)
            .set({ steeredIntoMessageId: second!.assistantId })
            .where(eq(messages.id, third!.userId)),
          db
            .update(messages)
            .set({ questionResponse: { callId: "ask", response: { kind: "skip" } } as never })
            .where(eq(messages.id, fourth!.userId)),
        ]),
      ),
    );

    const head = await run(loadConversationDetail(userId, thread.conversationId));

    // Turns 3 and 4 no longer count, so the window reaches back to turn 1.
    expect(head.window.anchorId).toBe(thread.turns[0]!.userId);
    expect(head.window.olderCursor).toBeNull();
  });

  it("starts a fresh window when a rewind removed its anchor", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedTurns(userId, HEAD_TURNS + 10));
    const head = await run(loadConversationDetail(userId, thread.conversationId));
    // A retry of turn 3 deletes everything after it, the anchor included.
    const rewound = thread.turns.slice(3).flatMap((turn) => [turn.userId, turn.assistantId]);
    await run(Effect.flatMap(Db, (db) => db.delete(messages).where(inArray(messages.id, rewound))));

    const again = await run(
      loadConversationDetail(userId, thread.conversationId, head.window.anchorId),
    );

    expect(again.window.anchorId).toBe(thread.turns[0]!.userId);
    expect(again.messages).toHaveLength(6);
    expect(again.window.olderCursor).toBeNull();
  });

  it("returns only the window's own rows and the earlier sources it cites", async () => {
    const userId = await run(makeUser());
    const thread = await run(seedTurns(userId, HEAD_TURNS + 2));
    await run(
      Effect.flatMap(Db, (db) =>
        db.insert(messageToolCalls).values({
          id: uuidv7(),
          messageId: thread.turns[0]!.assistantId,
          turnIndex: 0,
          callIndex: 0,
          providerCallId: "call",
          toolName: "web_search",
          arguments: {},
          status: "complete",
          result: { v: 1, family: "web", sources: [source(1), source(2)] },
        }),
      ),
    );
    await run(addTurn(thread.conversationId, HEAD_TURNS + 3, "As found earlier[^2]."));

    const head = await run(loadConversationDetail(userId, thread.conversationId));

    expect(head.toolCalls).toEqual([]);
    expect(head.priorSources).toEqual([source(2)]);
  });
});
