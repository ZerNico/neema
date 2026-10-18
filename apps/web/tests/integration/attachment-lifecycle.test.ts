import { readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted, Duration } from "effect";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  attachmentBlobs,
  attachments,
  blobCleanupIntents,
  conversations,
  messages,
  projectFiles,
  projectFileVersions,
  projects,
  user,
} from "~/db/schema/index.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { attachmentWriter } from "~/modules/attachments/server/service.ts";
import { BlobStoreError } from "~/modules/attachments/errors.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Db | AttachmentRepo, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Db | AttachmentRepo>) => runtime.runPromise(effect);
beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(
    AttachmentRepo.layer.pipe(
      Layer.provideMerge(
        Db.layer.pipe(
          Layer.provideMerge(
            PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 }),
          ),
        ),
      ),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});
const db = <A>(body: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  run(Effect.flatMap(Db, body));
const newUser = async () => {
  const id = uuidv7();
  await db((d) => d.insert(user).values({ id, name: "Lifecycle", email: `${id}@test.invalid` }));
  return id;
};

it("admits attachment associations before candidate writes and repeats the guard after I/O", async () => {
  const userId = await newUser();
  const stored = new Map<string, Uint8Array>();
  let admitted = false;
  const store = BlobStore.of({
    put: (key, bytes) =>
      Effect.sync(() => {
        stored.set(key, bytes);
        admitted = false;
      }),
    get: (key) =>
      stored.has(key)
        ? Effect.succeed(stored.get(key)!)
        : Effect.fail(new BlobStoreError({ operation: "get", key, message: "Missing" })),
    exists: (key) => Effect.succeed(stored.has(key)),
    delete: (key) =>
      Effect.sync(() => {
        stored.delete(key);
      }),
    deletePrefix: () => Effect.void,
  });
  const writer = await run(Effect.map(AttachmentRepo, (repo) => attachmentWriter(repo, store)));
  const association = {
    before: () => (admitted ? Effect.void : Effect.interrupt),
    after: () => Effect.void,
  };
  const input = {
    userId,
    fileName: "report.txt",
    declaredMediaType: "text/plain",
    bytes: new TextEncoder().encode("report"),
    association,
  };
  await expect(run(writer.upload(input))).rejects.toThrow("All fibers interrupted without error");
  expect(stored.size).toBe(0);
  expect(await db((d) => d.select().from(blobCleanupIntents))).toEqual([]);
  admitted = true;
  await expect(run(writer.upload(input))).rejects.toThrow("All fibers interrupted without error");
  expect(stored.size).toBe(1);
  expect(
    await db((d) => d.select().from(attachments).where(eq(attachments.userId, userId))),
  ).toEqual([]);
  expect(await db((d) => d.select().from(blobCleanupIntents))).toMatchObject([
    { kind: "candidate" },
  ]);
});

it("commits modest independent sweep batches and rechecks claims after acquiring blob locks", async () => {
  const userId = await newUser();
  const firstBlob = uuidv7(),
    secondBlob = uuidv7();
  const firstKey = `test/${firstBlob}`,
    secondKey = `test/${secondBlob}`;
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: uuidv7(),
    userId,
    blobId: index < 100 ? firstBlob : secondBlob,
    fileName: `upload-${index}.txt`,
    mediaType: "text/plain",
    createdAt: new Date(0),
  }));
  const chatId = uuidv7(),
    messageId = uuidv7(),
    projectId = uuidv7(),
    fileId = uuidv7();
  await db((d) =>
    d.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(attachmentBlobs).values([
          {
            id: firstBlob,
            userId,
            sha256: "a".repeat(64),
            storageKey: firstKey,
            size: 1,
            mediaType: "text/plain",
          },
          {
            id: secondBlob,
            userId,
            sha256: "b".repeat(64),
            storageKey: secondKey,
            size: 1,
            mediaType: "text/plain",
          },
        ]);
        yield* tx.insert(attachments).values(rows);
        yield* tx.insert(conversations).values({ id: chatId, userId });
        yield* tx
          .insert(messages)
          .values({ id: messageId, conversationId: chatId, role: "user", content: "file" });
        yield* tx.insert(projects).values({ id: projectId, userId, name: "Retainer" });
        yield* tx.insert(projectFiles).values({ id: fileId, projectId, name: "shared.txt" });
        yield* tx.insert(projectFileVersions).values({
          id: uuidv7(),
          fileId,
          number: 1,
          blobId: secondBlob,
          size: 1,
          mediaType: "text/plain",
          origin: "user",
          createdByUserId: userId,
        });
      }),
    ),
  );
  const locker = new Client({ connectionString: database.url });
  await locker.connect();
  await locker.query("begin");
  await locker.query("select id from attachment_blobs where id = $1 for update", [secondBlob]);
  const { pid } = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!;
  const sweeping = run(
    Effect.flatMap(AttachmentRepo, (repo) => repo.sweepUnclaimed(Duration.zero)),
  );
  try {
    const deadline = Date.now() + 10_000;
    let observed = false;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe committed batch progress and the next batch's actual blocker.
      const result = await locker.query<{ remaining: number; blocked: boolean }>(
        `select (select count(*)::int from attachments where user_id = $1) as remaining,
          exists(select 1 from pg_stat_activity where datname = current_database() and $2::int = any(pg_blocking_pids(pid))) as blocked`,
        [userId, pid],
      );
      if (result.rows[0]!.remaining === 105 && result.rows[0]!.blocked) {
        observed = true;
        break;
      }
    }
    expect(observed).toBe(true);
    // This transaction owns the claim's blob lock. The waiting sweep must see its commit.
    await locker.query(
      "insert into message_attachments (message_id, attachment_id, position) values ($1, $2, 0)",
      [messageId, rows[100]!.id],
    );
  } finally {
    await locker.query("commit");
    await locker.end();
  }
  expect(await sweeping).toEqual([firstKey]);
  expect(
    await db((d) =>
      d.select({ id: attachments.id }).from(attachments).where(eq(attachments.userId, userId)),
    ),
  ).toEqual([{ id: rows[100]!.id }]);
  expect(
    await db((d) =>
      d
        .select({ id: attachmentBlobs.id })
        .from(attachmentBlobs)
        .where(eq(attachmentBlobs.id, secondBlob)),
    ),
  ).toEqual([{ id: secondBlob }]);
  expect(
    await db((d) =>
      d.select().from(blobCleanupIntents).where(eq(blobCleanupIntents.storageKey, firstKey)),
    ),
  ).toMatchObject([{ kind: "orphan" }]);
  expect(
    await db((d) =>
      d
        .select({ count: sql<number>`count(*)::int` })
        .from(attachments)
        .where(eq(attachments.userId, userId)),
    ),
  ).toEqual([{ count: 1 }]);
});

it("backfills historical attachment types from blobs before requiring the resource type", async () => {
  // A separate clone keeps the application's pool away from the historical schema.
  const historical = await createTestDatabase();
  const client = new Client({ connectionString: historical.url });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("alter table attachments drop column media_type");
    const owner = uuidv7();
    await client.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      owner,
      "Historical",
      `${owner}@test.invalid`,
    ]);
    for (const [index, mediaType, fileName] of [
      [0, "application/octet-stream", "historical.txt"],
      [1, "text/plain", "historical.bin"],
    ] as const) {
      const blobId = uuidv7();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Seed each historical resource before applying the migration.
      await client.query(
        `insert into attachment_blobs (id, user_id, sha256, storage_key, size, media_type)
         values ($1, $2, $3, $4, 1, $5)`,
        [blobId, owner, `${index}`.repeat(64), `historical/${blobId}`, mediaType],
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Historical inserts deliberately have no attachment media_type column.
      await client.query(
        "insert into attachments (id, user_id, blob_id, file_name) values ($1, $2, $3, $4)",
        [uuidv7(), owner, blobId, fileName],
      );
    }
    const migration = await readFile(
      new URL("../../drizzle/20261012090751_dear_red_skull/migration.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    expect(
      (await client.query("select file_name, media_type from attachments order by file_name")).rows,
    ).toEqual([
      { file_name: "historical.bin", media_type: "text/plain" },
      { file_name: "historical.txt", media_type: "application/octet-stream" },
    ]);
    expect(
      (
        await client.query(
          `select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'attachments' and column_name = 'media_type'`,
        )
      ).rows,
    ).toEqual([{ is_nullable: "NO" }]);
    await expect(client.query("update attachments set media_type = null")).rejects.toMatchObject({
      code: "23502",
    });
  } finally {
    await client.query("rollback");
    await client.end();
    await historical.drop();
  }
});
