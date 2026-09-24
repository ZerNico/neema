import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, messages, schedules } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo, type ConversationCursor } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | Db, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  runtime = ManagedRuntime.make(
    ChatRepo.layer.pipe(
      Layer.provideMerge(AttachmentRepo.layer),
      Layer.provideMerge(Db.layer),
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
    ),
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

const BASE = new Date("2026-03-01T12:00:00Z").getTime();

/** Inserted directly so activity timestamps are exactly what each case needs. */
const seed = Effect.fn("test.seed")(function* (
  userId: string,
  rows: ReadonlyArray<{ id: string; title: string | null; created: number; last?: number | null }>,
) {
  const db = yield* Db;
  yield* db.insert(conversations).values(
    rows.map((row) => ({
      id: row.id,
      userId,
      title: row.title,
      createdAt: new Date(BASE + row.created),
      updatedAt: new Date(BASE + row.created),
      lastMessageAt: row.last === undefined || row.last === null ? null : new Date(BASE + row.last),
    })),
  );
});

const page = Effect.fn("test.page")(function* (
  userId: string,
  options: { limit: number; cursor?: ConversationCursor; query?: string },
) {
  const repo = yield* ChatRepo;
  const result = yield* repo.listConversations({ userId, ...options });
  return { ids: result.conversations.map((c) => c.id), nextCursor: result.nextCursor };
});

describe("listConversations pagination", () => {
  it("walks the whole list in contiguous, non-overlapping pages", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        // Ids ascend with recency, so the expected order is simply reversed.
        yield* seed(
          userId,
          Array.from({ length: 7 }, (_, index) => ({
            id: `c${index}`,
            title: `Chat ${index}`,
            created: index * 1000,
          })),
        );

        const seen: string[] = [];
        let cursor: ConversationCursor | undefined;
        let pages = 0;
        do {
          const next = yield* page(userId, { limit: 3, ...(cursor ? { cursor } : {}) });
          seen.push(...next.ids);
          cursor = next.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && pages < 10);
        return { seen, pages };
      }),
    );

    expect(result.seen).toEqual(["c6", "c5", "c4", "c3", "c2", "c1", "c0"]);
    expect(new Set(result.seen).size).toBe(7);
    // 3 + 3 + 1: the last page is short and reports no further cursor.
    expect(result.pages).toBe(3);
  });

  it("orders by last message, falling back to creation for an empty chat", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          // Created first but active most recently.
          { id: "old-but-active", title: "a", created: 0, last: 9000 },
          // Created last, never used, but still ranks by its creation time.
          { id: "new-and-empty", title: "b", created: 5000 },
          { id: "stale", title: "c", created: 1000, last: 2000 },
        ]);
        return (yield* page(userId, { limit: 10 })).ids;
      }),
    );
    expect(ids).toEqual(["old-but-active", "new-and-empty", "stale"]);
  });

  it("splits an identical activity timestamp deterministically by id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "aaa", title: "a", created: 0, last: 5000 },
          { id: "bbb", title: "b", created: 0, last: 5000 },
          { id: "ccc", title: "c", created: 0, last: 5000 },
        ]);
        const first = yield* page(userId, { limit: 2 });
        const second = yield* page(userId, {
          limit: 2,
          ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
        });
        return [...first.ids, ...second.ids];
      }),
    );
    expect(result).toEqual(["ccc", "bbb", "aaa"]);
  });

  it("returns a null cursor when the last page exactly fills the limit", async () => {
    const nextCursor = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "x1", title: "a", created: 0 },
          { id: "x2", title: "b", created: 1000 },
        ]);
        return (yield* page(userId, { limit: 2 })).nextCursor;
      }),
    );
    expect(nextCursor).toBeNull();
  });

  it("keeps one user's conversations out of another's pages", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const mine = yield* makeUser();
        const theirs = yield* makeUser();
        yield* seed(mine, [{ id: "mine-1", title: "shared title", created: 0 }]);
        yield* seed(theirs, [{ id: "theirs-1", title: "shared title", created: 1000 }]);
        return (yield* page(mine, { limit: 10, query: "shared" })).ids;
      }),
    );
    expect(ids).toEqual(["mine-1"]);
  });
});

describe("listConversations generating flag", () => {
  it("flags exactly the conversations with an answer still streaming", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        yield* seed(userId, [
          { id: "gen-busy", title: "Busy", created: 1000 },
          { id: "gen-idle", title: "Idle", created: 2000 },
        ]);
        // One finished turn in each; only the busy one has a second answer
        // still open. The finished rows prove the flag reads status, not
        // mere message existence.
        yield* db.insert(messages).values([
          { id: uuidv7(), conversationId: "gen-busy", role: "assistant", status: "complete" },
          { id: uuidv7(), conversationId: "gen-busy", role: "assistant", status: "streaming" },
          { id: uuidv7(), conversationId: "gen-idle", role: "assistant", status: "complete" },
        ]);
        const repo = yield* ChatRepo;
        const page = yield* repo.listConversations({ userId, limit: 10 });
        return page.conversations.map((c) => ({ id: c.id, generating: c.generating }));
      }),
    );
    expect(rows).toEqual([
      { id: "gen-idle", generating: false },
      { id: "gen-busy", generating: true },
    ]);
  });

  it("treats a failed or stopped answer as done", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        yield* seed(userId, [
          { id: "gen-err", title: "Errored", created: 1000 },
          { id: "gen-stop", title: "Stopped", created: 2000 },
        ]);
        yield* db.insert(messages).values([
          { id: uuidv7(), conversationId: "gen-err", role: "assistant", status: "error" },
          { id: uuidv7(), conversationId: "gen-stop", role: "assistant", status: "aborted" },
        ]);
        const repo = yield* ChatRepo;
        const page = yield* repo.listConversations({ userId, limit: 10 });
        return page.conversations.map((c) => c.generating);
      }),
    );
    expect(rows).toEqual([false, false]);
  });
});

describe("listConversations scheduled runs", () => {
  it("lists run chats like any chat and marks them as a schedule's", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const scheduleId = uuidv7();
        yield* db.insert(schedules).values({
          id: scheduleId,
          userId,
          name: "Digest",
          prompt: "Summarize.",
          scheduleText: "every weekday at 7am",
          cron: "0 7 * * 1-5",
          timezone: "UTC",
        });
        yield* seed(userId, [
          { id: "ordinary", title: "Ordinary", created: 0 },
          { id: "scheduled-run", title: "Scheduled run", created: 1000 },
        ]);
        // A run chat is an ordinary row with scheduleId set.
        yield* db
          .update(conversations)
          .set({ scheduleId })
          .where(eq(conversations.id, "scheduled-run"));
        const repo = yield* ChatRepo;
        const result = yield* repo.listConversations({ userId, limit: 10 });
        return result.conversations.map((c) => ({ id: c.id, scheduled: c.scheduled }));
      }),
    );
    expect(listed).toEqual([
      { id: "scheduled-run", scheduled: true },
      { id: "ordinary", scheduled: false },
    ]);
  });

  it("keeps a run chat when its schedule is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const scheduleId = uuidv7();
        yield* db.insert(schedules).values({
          id: scheduleId,
          userId,
          name: "Digest",
          prompt: "Summarize.",
          scheduleText: "every weekday at 7am",
          cron: "0 7 * * 1-5",
          timezone: "UTC",
        });
        yield* seed(userId, [
          { id: "kept", title: "Kept", created: 0 },
          { id: "run-chat", title: "Run", created: 1000 },
        ]);
        yield* db.update(conversations).set({ scheduleId }).where(eq(conversations.id, "run-chat"));
        yield* db.delete(schedules).where(eq(schedules.id, scheduleId));
        // The chats stay as ordinary ones; only the link back is cleared.
        return (yield* page(userId, { limit: 10 })).ids;
      }),
    );
    expect(result).toEqual(["run-chat", "kept"]);
  });
});

describe("listConversations title search", () => {
  it("matches case-insensitively and paginates the matches", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "s1", title: "Drizzle Migrations", created: 0 },
          { id: "s2", title: "postgres indexes", created: 1000 },
          { id: "s3", title: "drizzle relations", created: 2000 },
        ]);
        const first = yield* page(userId, { limit: 1, query: "DRIZZLE" });
        const second = yield* page(userId, {
          limit: 1,
          query: "DRIZZLE",
          ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
        });
        return [...first.ids, ...second.ids];
      }),
    );
    expect(result).toEqual(["s3", "s1"]);
  });

  it("treats %, _ and \\ as literal characters", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "l1", title: "100% done", created: 0 },
          { id: "l2", title: "nothing to see", created: 1000 },
          { id: "l3", title: "snake_case naming", created: 2000 },
          { id: "l4", title: "a b", created: 3000 },
          { id: "l5", title: "back\\slash", created: 4000 },
        ]);
        return {
          percent: (yield* page(userId, { limit: 10, query: "100%" })).ids,
          // Would match "a b" if `_` were still a single-character wildcard.
          underscore: (yield* page(userId, { limit: 10, query: "a_b" })).ids,
          backslash: (yield* page(userId, { limit: 10, query: "back\\slash" })).ids,
        };
      }),
    );
    expect(result).toEqual({ percent: ["l1"], underscore: [], backslash: ["l5"] });
  });

  it("never matches a chat whose title is still generating", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "p1", title: null, created: 0 },
          { id: "p2", title: "named", created: 1000 },
        ]);
        return {
          searched: (yield* page(userId, { limit: 10, query: "a" })).ids,
          unsearched: (yield* page(userId, { limit: 10 })).ids,
        };
      }),
    );
    // Blank search still lists it, since there is simply nothing to match against.
    expect(result).toEqual({ searched: ["p2"], unsearched: ["p2", "p1"] });
  });

  it("lists everything for a blank or whitespace-only query", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        yield* seed(userId, [
          { id: "w1", title: "one", created: 0 },
          { id: "w2", title: "two", created: 1000 },
        ]);
        return (yield* page(userId, { limit: 10, query: "   " })).ids;
      }),
    );
    expect(ids).toEqual(["w2", "w1"]);
  });
});

describe("temporary chat expiry", () => {
  const HOUR = 60 * 60 * 1000;

  it("deletes only temporary chats a day past their last activity with no live answer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const now = Date.now();
        const ids = {
          expired: uuidv7(),
          expiredNeverUsed: uuidv7(),
          fresh: uuidv7(),
          ordinary: uuidv7(),
          live: uuidv7(),
        };
        const row = (id: string, temporary: boolean, created: number, last: number | null) => ({
          id,
          userId,
          title: null,
          temporary,
          createdAt: new Date(created),
          updatedAt: new Date(created),
          lastMessageAt: last === null ? null : new Date(last),
        });
        yield* db
          .insert(conversations)
          .values([
            row(ids.expired, true, now - 48 * HOUR, now - 25 * HOUR),
            row(ids.expiredNeverUsed, true, now - 25 * HOUR, null),
            // Created long ago but active recently: the day runs from activity.
            row(ids.fresh, true, now - 48 * HOUR, now - 1 * HOUR),
            row(ids.ordinary, false, now - 48 * HOUR, now - 25 * HOUR),
            row(ids.live, true, now - 48 * HOUR, now - 25 * HOUR),
          ]);
        yield* db.insert(messages).values({
          id: uuidv7(),
          conversationId: ids.live,
          role: "assistant",
          status: "streaming",
          generationLeaseUntil: new Date(now + HOUR),
        });

        const listed = new Set((yield* repo.listExpiredTemporary(100)).map((r) => r.id));
        const deleted = yield* repo.deleteExpiredTemporary(ids.expired);
        const remaining = yield* db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.userId, userId));
        return { ids, listed, deleted, remaining: new Set(remaining.map((r) => r.id)) };
      }),
    );
    expect(result.listed).toEqual(new Set([result.ids.expired, result.ids.expiredNeverUsed]));
    expect(result.deleted).toEqual({ userId: expect.any(String), keys: [] });
    expect(result.remaining.has(result.ids.expired)).toBe(false);
    expect(result.remaining.has(result.ids.live)).toBe(true);
    expect(result.remaining.has(result.ids.fresh)).toBe(true);
    expect(result.remaining.has(result.ids.ordinary)).toBe(true);
  });

  it("lets a Keep that lands after the listing win", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const id = uuidv7();
        const long = new Date(Date.now() - 25 * HOUR);
        yield* db.insert(conversations).values({
          id,
          userId,
          temporary: true,
          createdAt: long,
          updatedAt: long,
          lastMessageAt: long,
        });
        const listed = (yield* repo.listExpiredTemporary(100)).some((r) => r.id === id);
        const kept = yield* repo.keepConversation(userId, id);
        const keptAgain = yield* repo.keepConversation(userId, id);
        const deleted = yield* repo.deleteExpiredTemporary(id);
        const [row] = yield* db.select().from(conversations).where(eq(conversations.id, id));
        return { listed, kept, keptAgain, deleted, temporary: row?.temporary };
      }),
    );
    expect(result).toEqual({
      listed: true,
      kept: true,
      keptAgain: false,
      deleted: null,
      temporary: false,
    });
  });
});
