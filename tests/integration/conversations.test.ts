import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo, type ConversationCursor } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";

let container: StartedPostgreSqlContainer;
let runtime: ManagedRuntime.ManagedRuntime<ChatRepo | Db, unknown>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  execSync("pnpm drizzle-kit migrate", {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

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
  await container?.stop();
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
          // Created last, never used — still ranks by its creation time.
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
    // Blank search still lists it — there is simply nothing to match against.
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
