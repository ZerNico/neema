import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, models } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { loadConversationDetail } from "~/modules/chat/server/conversation-detail.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

let container: StartedPostgreSqlContainer;
type Services = ChatRepo | AttachmentRepo | AgentRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
/** conversations.model_id / messages.model_id are real FKs. */
let modelId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  // Only what the detail read touches: no gateway, no stream engine, no
  // services — this exercises the payload assembly against real SQL.
  const InfraLayer = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ChatRepo.layer.pipe(Layer.provideMerge(AttachmentRepo.layer)),
      AgentRepo.layer,
    ).pipe(Layer.provideMerge(InfraLayer)),
  );

  modelId = uuidv7();
  const providerId = uuidv7();
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

/**
 * Points a conversation at a source directly. Branching only ever links two
 * conversations of the same owner, so the cross-owner case has to be written
 * in — the foreign key does not constrain it, and the read must not leak.
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

    // The whole payload still loads — an unreadable source drops the marker,
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
          skillIds: [],
          searchEnabled: false,
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
          skillIds: [],
          searchEnabled: true,
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
          skillIds: [],
          searchEnabled: true,
          available: false,
        });
        expect(deleted.messages).toEqual(first.messages);
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
