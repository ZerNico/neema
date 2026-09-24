import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, messages } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import type { Snippet } from "~/modules/search/text.ts";
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

interface SeedChat {
  title: string | null;
  at: number;
  temporary?: boolean;
  messages: ReadonlyArray<{
    role?: "user" | "assistant" | "system";
    content: string;
    at?: number;
  }>;
}

/** A fresh user with the given chats; returns the user and chat ids in order. */
const seed = (chats: ReadonlyArray<SeedChat>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = uuidv7();
      yield* db.execute(
        sql`insert into "user" (id, name, email) values (${userId}, 'Searcher', ${`${userId}@t.io`})`,
      );
      const ids: string[] = [];
      for (const chat of chats) {
        const id = uuidv7();
        ids.push(id);
        yield* db.insert(conversations).values({
          id,
          userId,
          title: chat.title,
          createdAt: new Date(BASE + chat.at),
          updatedAt: new Date(BASE + chat.at),
          lastMessageAt: new Date(BASE + chat.at),
          temporary: chat.temporary ?? false,
        });
        if (chat.messages.length)
          yield* db.insert(messages).values(
            chat.messages.map((message, index) => ({
              id: uuidv7(),
              conversationId: id,
              role: message.role ?? "assistant",
              content: message.content,
              createdAt: new Date(BASE + chat.at + (message.at ?? index)),
            })),
          );
      }
      return { userId, ids };
    }),
  );

const search = (userId: string, query: string, limit = 8) =>
  runtime.runPromise(
    Effect.flatMap(ChatRepo, (repo) => repo.searchConversations({ userId, query, limit })),
  );

const highlighted = (snippet: Snippet | null) =>
  snippet?.highlights.map(([start, end]) => snippet.text.slice(start, end)) ?? [];

describe("chat search", () => {
  it("matches word prefixes in message text and highlights them", async () => {
    const { userId, ids } = await seed([
      {
        title: "Travel",
        at: 0,
        messages: [
          { role: "user", content: "Welche Koffergrößen erlaubt Ryanair?" },
          { content: "Das kleine Handgepäck darf 40 × 30 × 20 cm groß sein." },
        ],
      },
      { title: "Unrelated", at: 1, messages: [{ content: "Nothing to see here." }] },
    ]);

    const [hit, ...rest] = await search(userId, "handgep");
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({ conversationId: ids[0], title: "Travel" });
    expect(hit!.messageId).not.toBeNull();
    expect(highlighted(hit!.snippet)).toEqual(["Handgepäck"]);
  });

  it("ignores accents in both directions and requires every term", async () => {
    const { userId, ids } = await seed([
      { title: null, at: 0, messages: [{ content: "Koffergrößen im Café vergleichen" }] },
      { title: null, at: 1, messages: [{ content: "Koffer im Keller" }] },
    ]);

    expect((await search(userId, "koffergrossen")).map((hit) => hit.conversationId)).toEqual([
      ids[0],
    ]);
    expect((await search(userId, "cafe koffer")).map((hit) => hit.conversationId)).toEqual([
      ids[0],
    ]);
    expect((await search(userId, "KOFFER")).map((hit) => hit.conversationId)).toEqual([
      ids[1],
      ids[0],
    ]);
  });

  it("puts title matches first, then the most recent chats, one row per chat", async () => {
    const { userId, ids } = await seed([
      { title: "Postgres tuning", at: 0, messages: [{ content: "unrelated" }] },
      {
        title: "Later chat",
        at: 10,
        messages: [
          { content: "postgres once", at: 1 },
          { content: "postgres twice, the newest", at: 2 },
        ],
      },
      { title: "Latest chat", at: 20, messages: [{ content: "we used postgres" }] },
    ]);

    const hits = await search(userId, "postgres");
    expect(hits.map((hit) => hit.conversationId)).toEqual([ids[0], ids[2], ids[1]]);
    // The title-only match carries no excerpt; a chat's newest match is its excerpt.
    expect(hits[0]!.snippet).toBeNull();
    expect(hits[2]!.snippet?.text).toContain("twice");
  });

  it("fills a page from recent chats, newest first, with each chat's newest match", async () => {
    const { userId, ids } = await seed([
      { title: null, at: 0, messages: [{ content: "oldest lantern" }] },
      {
        title: null,
        at: 10,
        messages: [
          { content: "lantern first", at: 1 },
          { content: "unrelated", at: 2 },
          { content: "lantern again, newest", at: 3 },
        ],
      },
      { title: null, at: 20, messages: [{ content: "a lantern too" }] },
    ]);

    // A limit the recent window can fill, so the index fallback never runs.
    const hits = await search(userId, "lantern", 2);
    expect(hits.map((hit) => hit.conversationId)).toEqual([ids[2], ids[1]]);
    expect(hits[1]!.snippet?.text).toContain("newest");
  });

  it("reaches chats older than the recent window through the index", async () => {
    const { userId, ids } = await seed([
      { title: null, at: 0, messages: [{ content: "ancient zeppelin notes" }] },
      ...Array.from({ length: 45 }, (_, index) => ({
        title: `Recent ${index}`,
        at: 100 + index,
        messages: [{ content: `recent chat number ${index}` }],
      })),
    ]);

    const hits = await search(userId, "zeppelin");
    expect(hits.map((hit) => hit.conversationId)).toEqual([ids[0]]);
    expect(highlighted(hits[0]!.snippet)).toEqual(["zeppelin"]);
  });

  it("never returns another user's chats or system prompts", async () => {
    const mine = await seed([
      { title: null, at: 0, messages: [{ role: "system", content: "secretword instructions" }] },
    ]);
    await seed([{ title: "secretword", at: 1, messages: [{ content: "secretword" }] }]);

    expect(await search(mine.userId, "secretword")).toEqual([]);
  });

  it("forgets a deleted chat and keeps citation markers and emphasis out of excerpts", async () => {
    const { userId, ids } = await seed([
      { title: null, at: 0, messages: [{ content: "The **limit** is 10 kg[^3] per bag." }] },
      { title: null, at: 1, messages: [{ content: "limit reached" }] },
    ]);
    await runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db.delete(conversations).where(eq(conversations.id, ids[1]!)).pipe(Effect.asVoid),
      ),
    );

    const hits = await search(userId, "limit");
    expect(hits.map((hit) => hit.conversationId)).toEqual([ids[0]]);
    expect(hits[0]!.snippet?.text).toBe("The limit is 10 kg per bag.");
    expect(highlighted(hits[0]!.snippet)).toEqual(["limit"]);
  });

  it("matches titles by substring and treats punctuation-only input as a title search", async () => {
    const { userId, ids } = await seed([
      { title: "C++ questions", at: 0, messages: [{ content: "templates" }] },
      { title: "東京タワーの旅行", at: 1, messages: [] },
    ]);

    expect((await search(userId, "++")).map((hit) => hit.conversationId)).toEqual([ids[0]]);
    expect((await search(userId, "タワー")).map((hit) => hit.conversationId)).toEqual([ids[1]]);
    expect(await search(userId, "   ")).toEqual([]);
  });

  it("uses the message index rather than scanning every message", async () => {
    const plan = await runtime.runPromise(
      Effect.flatMap(Db, (db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`set local enable_seqscan = off`);
            return yield* tx.execute(
              sql`explain select id from messages where to_tsvector('app_search'::regconfig, content) @@ to_tsquery('app_search'::regconfig, 'koffer:*')`,
            );
          }),
        ),
      ),
    );
    expect(JSON.stringify(plan)).toContain("messages_search_idx");
  });
});

describe("chat search and temporary chats", () => {
  // Title, recent-window and indexed matches are separate queries; a word
  // this rare runs all three, so a leak in any one shows here.
  it("finds a temporary chat by neither title nor text until it is kept", async () => {
    const { userId, ids } = await seed([
      { title: "Ordinary", at: 0, messages: [{ content: "nothing to see" }] },
      {
        title: "Zanzibar plans",
        at: 1000,
        temporary: true,
        messages: [{ content: "a zanzibar itinerary" }],
      },
    ]);
    const temporaryId = ids[1]!;
    expect(await search(userId, "zanzibar")).toEqual([]);
    expect(await search(userId, "itinerary")).toEqual([]);
    const listed = await runtime.runPromise(
      Effect.flatMap(ChatRepo, (repo) => repo.listConversations({ userId, limit: 10 })),
    );
    expect(listed.conversations.map((c) => c.id)).toEqual([ids[0]]);

    await runtime.runPromise(
      Effect.flatMap(ChatRepo, (repo) => repo.keepConversation(userId, temporaryId)),
    );
    expect((await search(userId, "zanzibar")).map((hit) => hit.conversationId)).toEqual([
      temporaryId,
    ]);
    expect((await search(userId, "itinerary")).map((hit) => hit.conversationId)).toEqual([
      temporaryId,
    ]);
  });
});
