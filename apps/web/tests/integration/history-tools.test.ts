import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, messages, projects } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { prepareHistoryTools } from "~/modules/chat/server/history-tools.ts";
import { ChatRepo, type ChatScope } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | Db, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(
    ChatRepo.layer.pipe(
      Layer.provideMerge(AttachmentRepo.layer),
      Layer.provideMerge(Db.layer),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
    ),
  );
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const BASE = new Date("2026-05-01T12:00:00Z").getTime();

interface SeedMessage {
  role?: "user" | "assistant" | "system";
  content: string;
  status?: "streaming" | "complete" | "error";
  /** Index of the seeded message this one was steered into. */
  steeredInto?: number;
}

interface SeedChat {
  title: string;
  temporary?: boolean;
  archived?: boolean;
  deleted?: boolean;
  project?: boolean;
  messages?: ReadonlyArray<SeedMessage>;
}

const createUser = Effect.gen(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    sql`insert into "user" (id, name, email) values (${userId}, 'Reader', ${`${userId}@t.io`})`,
  );
  return userId;
});

/** One user's chats, each with its messages in order; returns every id. */
const seed = (chats: ReadonlyArray<SeedChat>, owner?: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = owner ?? (yield* createUser);
      const projectId = uuidv7();
      yield* db.insert(projects).values({ id: projectId, userId, name: "Launch" });
      const chatIds: string[] = [];
      const messageIds: string[][] = [];
      for (const [index, chat] of chats.entries()) {
        const id = uuidv7();
        chatIds.push(id);
        const at = new Date(BASE + index * 1000);
        yield* db.insert(conversations).values({
          id,
          userId,
          title: chat.title,
          createdAt: at,
          updatedAt: at,
          lastMessageAt: at,
          temporary: chat.temporary ?? false,
          archivedAt: chat.archived ? at : null,
          deletedAt: chat.deleted ? at : null,
          projectId: chat.project ? projectId : null,
        });
        const ids = (chat.messages ?? []).map(() => uuidv7());
        messageIds.push(ids);
        for (const [position, message] of (chat.messages ?? []).entries())
          yield* db.insert(messages).values({
            id: ids[position]!,
            conversationId: id,
            role: message.role ?? (position % 2 ? "assistant" : "user"),
            content: message.content,
            status: message.status ?? "complete",
            steeredIntoMessageId:
              message.steeredInto === undefined ? null : ids[message.steeredInto]!,
            createdAt: new Date(at.getTime() + position),
          });
      }
      return { userId, projectId, chatIds, messageIds };
    }),
  );

const withRepo = <A>(use: (repo: ChatRepo["Service"]) => Effect.Effect<A>) =>
  runtime.runPromise(Effect.flatMap(ChatRepo, use));

const call = (
  input: {
    userId: string;
    conversationId: string;
    messageId: string;
    otherChats: ChatScope | null;
  },
  name: string,
  args: unknown,
) =>
  withRepo((repo) => {
    const group = prepareHistoryTools({ repo, ...input });
    return (group.handlers[name] as (args: unknown) => Effect.Effect<Record<string, unknown>>)(
      args,
    );
  });

describe("this chat's history", () => {
  it("numbers settled messages, leaving out the attempt and the steers that went with one", async () => {
    const { chatIds, messageIds, userId } = await seed([
      {
        title: "Planning",
        messages: [
          { content: "We picked Postgres for the ledger." },
          { content: "Good, Postgres it is." },
          { role: "system", content: "internal" },
          { role: "user", content: "And the queue?" },
          { role: "assistant", content: "partial", status: "streaming" },
          { role: "user", content: "steered in", steeredInto: 4 },
          { role: "assistant", content: "failed", status: "error" },
          { role: "user", content: "orphaned remark", steeredInto: 6 },
        ],
      },
    ]);
    const input = {
      userId,
      conversationId: chatIds[0]!,
      messageId: messageIds[0]![4]!,
      otherChats: null,
    };

    const page = await call(input, "read_history", {});
    expect(page).toMatchObject({ ok: true, from: 1, to: 3, total: 3, nextFrom: null });
    expect(page.messages).toMatchObject([
      { number: 1, role: "user", text: "We picked Postgres for the ledger." },
      { number: 2, role: "assistant", text: "Good, Postgres it is." },
      { number: 3, role: "user", text: "And the queue?" },
    ]);

    const second = await call(input, "read_history", { from: 2, count: 1 });
    expect(second).toMatchObject({ from: 2, to: 2, nextFrom: 3 });

    const found = await call(input, "read_history", { query: "postgr" });
    expect(found).toMatchObject({ ok: true, matches: 2, nextFrom: null });
    expect(found.hits).toMatchObject([{ number: 1 }, { number: 2 }]);
    expect(await call(input, "read_history", { query: "postgr", from: 2 })).toMatchObject({
      matches: 1,
      hits: [{ number: 2, role: "assistant" }],
    });
    expect(await call(input, "read_history", { query: "steered" })).toMatchObject({
      matches: 0,
    });
    expect(await call(input, "read_history", { query: "orphaned" })).toMatchObject({
      matches: 0,
    });
    expect(await call(input, "read_history", { from: 9 })).toMatchObject({ ok: false, total: 3 });
  });

  it("pages a long history within its budget", async () => {
    const long = "word ".repeat(1_000);
    const { chatIds, userId } = await seed([
      { title: "Long", messages: Array.from({ length: 6 }, () => ({ content: long })) },
    ]);
    const input = { userId, conversationId: chatIds[0]!, messageId: uuidv7(), otherChats: null };
    const first = await call(input, "read_history", { count: 50 });
    expect(first).toMatchObject({ from: 1, to: 2, total: 6, nextFrom: 3 });
    expect(await call(input, "read_history", { from: 5 })).toMatchObject({
      from: 5,
      to: 6,
      nextFrom: null,
    });
    expect(await call(input, "read_history", { from: 9 })).toMatchObject({ ok: false, total: 6 });
  });
});

describe("the person's other chats", () => {
  it("finds only chats the scope allows, archived ones included", async () => {
    const { chatIds, userId } = await seed([
      { title: "Current", messages: [{ content: "Kayak rental in Oslo" }] },
      { title: "Earlier", messages: [{ content: "Kayak rental prices" }] },
      { title: "Old", archived: true, messages: [{ content: "Kayak trip" }] },
      { title: "Scratch", temporary: true, messages: [{ content: "Kayak secret" }] },
      { title: "Gone", deleted: true, messages: [{ content: "Kayak deleted" }] },
      { title: "In project", project: true, messages: [{ content: "Kayak for the team" }] },
    ]);
    await seed([{ title: "Someone else", messages: [{ content: "Kayak too" }] }]);
    const scope = { excludeId: chatIds[0]!, projectId: null };
    const input = {
      userId,
      conversationId: chatIds[0]!,
      messageId: uuidv7(),
      otherChats: scope,
    };

    const found = await call(input, "search_chats", { query: "kayak" });
    expect(found).toMatchObject({ ok: true, matches: 2 });
    expect(found.chats).toEqual([
      expect.objectContaining({ chatId: chatIds[2], title: "Old", archived: true }),
      expect.objectContaining({ chatId: chatIds[1], title: "Earlier", archived: false }),
    ]);

    const read = await call(input, "read_chat", { chatId: chatIds[1] });
    expect(read).toMatchObject({ ok: true, chatTitle: "Earlier", total: 1 });
    expect(read.messages).toMatchObject([{ number: 1, text: "Kayak rental prices" }]);
    for (const refused of [chatIds[0], chatIds[3], chatIds[4], chatIds[5]])
      expect(await call(input, "read_chat", { chatId: refused })).toMatchObject({ ok: false });
  });

  it("stays inside the current chat's project", async () => {
    const seeded = await seed([
      { title: "Current", project: true, messages: [{ content: "Budget review" }] },
      { title: "Project chat", project: true, messages: [{ content: "Budget for Q3" }] },
      { title: "Outside", messages: [{ content: "Budget at home" }] },
    ]);
    const { chatIds, userId, projectId } = seeded;
    const input = {
      userId,
      conversationId: chatIds[0]!,
      messageId: uuidv7(),
      otherChats: { excludeId: chatIds[0]!, projectId },
    };
    const found = await call(input, "search_chats", { query: "budget" });
    expect(found.chats).toEqual([expect.objectContaining({ chatId: chatIds[1] })]);
    expect(await call(input, "read_chat", { chatId: chatIds[2] })).toMatchObject({ ok: false });
  });

  it("never reads another person's chat", async () => {
    const mine = await seed([{ title: "Mine", messages: [{ content: "hello" }] }]);
    const theirs = await seed([{ title: "Theirs", messages: [{ content: "hello" }] }]);
    const input = {
      userId: mine.userId,
      conversationId: mine.chatIds[0]!,
      messageId: uuidv7(),
      otherChats: { excludeId: mine.chatIds[0]!, projectId: null },
    };
    expect(await call(input, "read_chat", { chatId: theirs.chatIds[0] })).toMatchObject({
      ok: false,
    });
  });
});
