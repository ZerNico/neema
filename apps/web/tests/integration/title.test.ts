import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, models } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Response as AiResponse } from "effect/ai";
import { generateConversationTitle, type TitleDeps } from "~/modules/chat/server/title.ts";
import { Db } from "~/server/db.ts";
import { purgeConversation } from "./purge.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
/** conversations.model_id is a real FK. */
let modelId: string;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | Db, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const AppLayer = ChatRepo.layer.pipe(
    Layer.provideMerge(AttachmentRepo.layer),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  runtime = ManagedRuntime.make(AppLayer);

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

const run = <A, E>(effect: Effect.Effect<A, E, ChatRepo | Db>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const makeUser = Effect.fn("test.makeUser")(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
  );
  return userId;
});

const startConversation = Effect.fn("test.startConversation")(function* (
  userId: string,
  content = "how do I seed a database?",
) {
  const repo = yield* ChatRepo;
  const turn = yield* repo.createTurn({
    userId,
    conversation: { kind: "new", id: uuidv7(), mode: "chat" },
    modelId,
    content,
    attachmentIds: [],
  });
  return turn.conversation.id;
});

const titleOf = Effect.fn("test.titleOf")(function* (conversationId: string) {
  const db = yield* Db;
  const rows = yield* db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return rows[0]?.title;
});

/** Real repo, stubbed model + bus: this is about what lands in Postgres. */
const depsWith = (repo: ChatRepo["Service"], generated: string) => {
  const publish = vi.fn(() => Effect.void);
  const deps: TitleDeps = {
    gateway: {
      generateText: () =>
        Effect.succeed({
          text: generated,
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
        }),
    },
    repo,
    sync: { publish } as TitleDeps["sync"],
    // Empty usage above means recordTitleUsage returns before touching these.
    providers: {
      getModel: () => Effect.succeed(null),
      getUtilityModelId: () => Effect.succeed(null),
    },
    analytics: { record: () => Effect.void },
  };
  return { deps, publish };
};

describe("conversation titles", () => {
  it("starts a new conversation without a title", async () => {
    const title = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        return yield* titleOf(yield* startConversation(userId));
      }),
    );
    expect(title).toBeNull();
  });

  it("resolves a pending title exactly once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* startConversation(userId);

        const first = yield* repo.setTitleIfPending(conversationId, "Seeding a database");
        const second = yield* repo.setTitleIfPending(conversationId, "Something else");
        return { first, second, title: yield* titleOf(conversationId) };
      }),
    );
    expect(result).toEqual({ first: true, second: false, title: "Seeding a database" });
  });

  it("reports no-op for a conversation that was deleted meanwhile", async () => {
    const applied = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* startConversation(userId);
        yield* purgeConversation(userId, conversationId);
        return yield* repo.setTitleIfPending(conversationId, "Gone");
      }),
    );
    expect(applied).toBe(false);
  });

  it("writes the generated title and announces it", async () => {
    const { title, published } = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* startConversation(userId);
        const { deps, publish } = depsWith(repo, "Seeding a database");

        yield* generateConversationTitle(deps, {
          userId,
          conversationId,
          modelId,
          content: "how do I seed a database?",
          attachmentFileNames: [],
        });
        return { title: yield* titleOf(conversationId), published: publish.mock.calls.length };
      }),
    );
    expect(title).toBe("Seeding a database");
    expect(published).toBe(1);
  });

  it("leaves a manual rename that landed first alone", async () => {
    const { title, published } = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* startConversation(userId);
        yield* repo.updateConversation(conversationId, { title: "Named by hand" });

        const { deps, publish } = depsWith(repo, "Seeding a database");
        yield* generateConversationTitle(deps, {
          userId,
          conversationId,
          modelId,
          content: "how do I seed a database?",
          attachmentFileNames: [],
        });
        return { title: yield* titleOf(conversationId), published: publish.mock.calls.length };
      }),
    );
    expect(title).toBe("Named by hand");
    expect(published).toBe(0);
  });

  it("lets a rename overwrite a title that generation already wrote", async () => {
    const title = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const conversationId = yield* startConversation(userId);
        const { deps } = depsWith(repo, "Seeding a database");

        yield* generateConversationTitle(deps, {
          userId,
          conversationId,
          modelId,
          content: "how do I seed a database?",
          attachmentFileNames: [],
        });
        yield* repo.updateConversation(conversationId, { title: "Named by hand" });
        return yield* titleOf(conversationId);
      }),
    );
    expect(title).toBe("Named by hand");
  });
});
