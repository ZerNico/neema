import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { attachmentBlobs, attachments, conversations, models, tools } from "~/db/schema/index.ts";
import { BlobStore, userBlobPrefix } from "~/modules/attachments/server/blob-store.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "attachments-it-"));

let container: StartedPostgreSqlContainer;
/** messages.model_id and conversations.model_id are real FKs. */
let modelId: string;
let runtime: ManagedRuntime.ManagedRuntime<
  AttachmentRepo | AttachmentService | BlobStore | ChatRepo | Db,
  unknown
>;

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
  // ChatRepo claims attachments inside its own transactions, so AttachmentRepo
  // sits underneath it; AttachmentService adds the storage side.
  const ReposLayer = ChatRepo.layer.pipe(
    Layer.provideMerge(AttachmentRepo.layer),
    Layer.provideMerge(InfraLayer),
  );
  const AppLayer = AttachmentService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(fsBlobStoreLayer, ReposLayer)),
  );
  runtime = ManagedRuntime.make(AppLayer);

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

const run = <A, E>(
  effect: Effect.Effect<A, E, AttachmentRepo | AttachmentService | BlobStore | ChatRepo | Db>,
) => runtime.runPromise(effect as never) as Promise<A>;

const bytes = (value: string) => new TextEncoder().encode(value);

const makeUser = Effect.fn("test.makeUser")(function* () {
  const db = yield* Db;
  const userId = uuidv7();
  yield* db.execute(
    `insert into "user" (id, name, email) values ('${userId}', 'Test', '${userId}@t.io')` as never,
  );
  return userId;
});

const upload = (userId: string, fileName: string, content: string) =>
  Effect.gen(function* () {
    const service = yield* AttachmentService;
    return yield* service.upload({
      userId,
      fileName,
      declaredMediaType: "text/plain",
      bytes: bytes(content),
    });
  });

/** resetMessageForRetry only claims an assistant that is no longer streaming. */
const finish = (messageId: string) =>
  Effect.gen(function* () {
    const repo = yield* ChatRepo;
    yield* repo.finalizeMessage({ messageId, status: "complete", content: "ok" });
  });

const blobsOf = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* db.select().from(attachmentBlobs).where(eq(attachmentBlobs.userId, userId));
  });

const attachmentCount = (userId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.select().from(attachments).where(eq(attachments.userId, userId));
    return rows.length;
  });

describe("attachment storage", () => {
  it("dedupes identical bytes per user and keeps users apart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const alice = yield* makeUser();
        const bob = yield* makeUser();

        const first = yield* upload(alice, "notes.txt", "same bytes");
        const second = yield* upload(alice, "copy.txt", "same bytes");
        const other = yield* upload(bob, "notes.txt", "same bytes");

        const aliceBlobs = yield* blobsOf(alice);
        const bobBlobs = yield* blobsOf(bob);
        return {
          differentAttachments: first.id !== second.id,
          aliceBlobCount: aliceBlobs.length,
          aliceAttachments: yield* attachmentCount(alice),
          bobBlobCount: bobBlobs.length,
          sameHash: aliceBlobs[0]!.sha256 === bobBlobs[0]!.sha256,
          // Same content, different owners: never the same object.
          separateKeys: aliceBlobs[0]!.storageKey !== bobBlobs[0]!.storageKey,
          bothStored:
            (yield* store.exists(aliceBlobs[0]!.storageKey)) &&
            (yield* store.exists(bobBlobs[0]!.storageKey)),
          otherOwnedByBob: other.id !== first.id,
        };
      }),
    );

    expect(result).toEqual({
      differentAttachments: true,
      aliceBlobCount: 1,
      aliceAttachments: 2,
      bobBlobCount: 1,
      sameHash: true,
      separateKeys: true,
      bothStored: true,
      otherOwnedByBob: true,
    });
  });

  it("returns a DTO that reveals nothing about storage", async () => {
    const dto = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        return yield* upload(userId, "../../etc/passwd", "leaky");
      }),
    );

    expect(Object.keys(dto).sort()).toEqual(["fileName", "id", "kind", "mediaType", "size"]);
    // Path components are stripped before the name is ever stored.
    expect(dto.fileName).toBe("passwd");
    expect(JSON.stringify(dto)).not.toContain("blobs/");
  });
});

describe("attachment claiming", () => {
  it("claims attachments with a turn and refuses a second claim", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const userId = yield* makeUser();
        const first = yield* upload(userId, "a.txt", "a");
        const second = yield* upload(userId, "b.txt", "b");

        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId,
          content: "look",
          attachmentIds: [second.id, first.id],
        });

        const linked = yield* attachmentRepo.listForMessages([turn.userMessage.id]);
        // Finish the first generation so the next turn passes the busy guard
        // and fails on the claim itself — the thing this test is about.
        yield* finish(turn.assistant.id);
        const reclaim = yield* repo
          .createTurn({
            userId,
            conversationId: turn.conversation.id,
            modelId,
            content: "again",
            attachmentIds: [first.id],
          })
          .pipe(Effect.flip);

        return {
          // Position follows the order the client sent, not upload order.
          order: linked.map((row) => row.fileName),
          reclaim: reclaim._tag,
          messagesAfterFailure: (yield* repo.listMessages(turn.conversation.id)).length,
        };
      }),
    );

    expect(result).toEqual({
      order: ["b.txt", "a.txt"],
      reclaim: "AttachmentNotAvailable",
      // The failed turn rolled back: only the first turn's two messages remain.
      messagesAfterFailure: 2,
    });
  });

  it("refuses another user's attachment and rolls the whole turn back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const alice = yield* makeUser();
        const bob = yield* makeUser();
        const hers = yield* upload(alice, "hers.txt", "hers");
        const his = yield* upload(bob, "his.txt", "his");

        const error = yield* repo
          .createTurn({
            userId: bob,
            conversationId: null,
            modelId,
            content: "steal",
            attachmentIds: [his.id, hers.id],
          })
          .pipe(Effect.flip);

        const db = yield* Db;
        const rows = yield* db.select().from(conversations).where(eq(conversations.userId, bob));
        return { tag: error._tag, conversations: rows.length };
      }),
    );

    // No conversation, no message, and his own attachment stays unclaimed.
    expect(result).toEqual({ tag: "AttachmentNotAvailable", conversations: 0 });
  });

  it("rejects a duplicated id in one claim", async () => {
    const tag = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const userId = yield* makeUser();
        const only = yield* upload(userId, "a.txt", "a");
        const error = yield* repo
          .createTurn({
            userId,
            conversationId: null,
            modelId,
            content: "twice",
            attachmentIds: [only.id, only.id],
          })
          .pipe(Effect.flip);
        return error._tag;
      }),
    );
    expect(tag).toBe("AttachmentNotAvailable");
  });
});

describe("attachment replacement on edit", () => {
  it("keeps, adds, reorders and releases in one transaction", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const store = yield* BlobStore;
        const userId = yield* makeUser();
        const kept = yield* upload(userId, "kept.txt", "kept");
        const dropped = yield* upload(userId, "dropped.txt", "dropped");
        const added = yield* upload(userId, "added.txt", "added");

        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId,
          content: "first",
          attachmentIds: [kept.id, dropped.id],
        });
        const droppedKey = (yield* attachmentRepo.listWithBlobsByIds(userId, [dropped.id]))[0]!
          .storageKey;

        yield* finish(turn.assistant.id);
        const { orphanedKeys } = yield* repo.resetMessageForRetry({
          userId,
          messageId: turn.assistant.id,
          modelId,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
          edit: {
            messageId: turn.userMessage.id,
            conversationId: turn.conversation.id,
            content: "edited",
            attachmentIds: [added.id, kept.id],
          },
        });

        const service = yield* AttachmentService;
        yield* service.deleteBlobs(orphanedKeys);

        return {
          linked: (yield* attachmentRepo.listForMessages([turn.userMessage.id])).map(
            (row) => row.fileName,
          ),
          orphanedKeys: [...orphanedKeys],
          droppedKey,
          droppedBytesGone: !(yield* store.exists(droppedKey)),
          remaining: yield* attachmentCount(userId),
        };
      }),
    );

    expect(result.linked).toEqual(["added.txt", "kept.txt"]);
    expect(result.orphanedKeys).toEqual([result.droppedKey]);
    expect(result.droppedBytesGone).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("keeps the blob alive while another attachment still references it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const store = yield* BlobStore;
        const userId = yield* makeUser();
        // Same bytes twice: two attachment rows, one blob.
        const first = yield* upload(userId, "one.txt", "shared bytes");
        const second = yield* upload(userId, "two.txt", "shared bytes");
        const key = (yield* blobsOf(userId))[0]!.storageKey;

        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId,
          content: "both",
          attachmentIds: [first.id, second.id],
        });

        const service = yield* AttachmentService;
        // Release just one of them.
        yield* finish(turn.assistant.id);
        const partial = yield* repo.resetMessageForRetry({
          userId,
          messageId: turn.assistant.id,
          modelId,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
          edit: {
            messageId: turn.userMessage.id,
            conversationId: turn.conversation.id,
            content: "one only",
            attachmentIds: [first.id],
          },
        });
        yield* service.deleteBlobs(partial.orphanedKeys);
        const survivesOneReference = yield* store.exists(key);

        // Deleting the conversation releases the last reference.
        const conversationKeys = yield* repo.deleteConversation(userId, turn.conversation.id);
        yield* service.deleteBlobs(conversationKeys);

        return {
          survivesOneReference,
          partialOrphans: partial.orphanedKeys.length,
          goneAfterLastReference: !(yield* store.exists(key)),
          blobRows: (yield* blobsOf(userId)).length,
          attachmentRows: yield* attachmentCount(userId),
        };
      }),
    );

    expect(result).toEqual({
      survivesOneReference: true,
      partialOrphans: 0,
      goneAfterLastReference: true,
      blobRows: 0,
      attachmentRows: 0,
    });
  });

  it("deleting someone else's conversation releases nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* ChatRepo;
        const store = yield* BlobStore;
        const alice = yield* makeUser();
        const mallory = yield* makeUser();

        const hers = yield* upload(alice, "hers.txt", "alice bytes");
        const turn = yield* repo.createTurn({
          userId: alice,
          conversationId: null,
          modelId,
          content: "mine",
          attachmentIds: [hers.id],
        });
        const key = (yield* blobsOf(alice))[0]!.storageKey;

        // The ownership check must gate the attachment release, not just the
        // conversation delete — otherwise this destroys Alice's files.
        const keys = yield* repo.deleteConversation(mallory, turn.conversation.id);

        const db = yield* Db;
        const stillThere = yield* db
          .select()
          .from(conversations)
          .where(eq(conversations.id, turn.conversation.id));
        return {
          returnedKeys: keys.length,
          conversationSurvives: stillThere.length,
          attachmentRows: yield* attachmentCount(alice),
          blobRows: (yield* blobsOf(alice)).length,
          bytesSurvive: yield* store.exists(key),
        };
      }),
    );

    expect(result).toEqual({
      returnedKeys: 0,
      conversationSurvives: 1,
      attachmentRows: 1,
      blobRows: 1,
      bytesSurvive: true,
    });
  });
});

describe("attachment access policy", () => {
  it("serves the owner and the conversation owner, and hides everything else", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* AttachmentService;
        const repo = yield* ChatRepo;
        const alice = yield* makeUser();
        const bob = yield* makeUser();
        const own = yield* upload(alice, "note.txt", "private words");

        const unclaimed = yield* service.read({ userId: alice, attachmentId: own.id });
        const strangerBeforeClaim = yield* service
          .read({ userId: bob, attachmentId: own.id })
          .pipe(Effect.flip);

        yield* repo.createTurn({
          userId: alice,
          conversationId: null,
          modelId,
          content: "sent",
          attachmentIds: [own.id],
        });

        const claimed = yield* service.read({ userId: alice, attachmentId: own.id });
        const strangerAfterClaim = yield* service
          .read({ userId: bob, attachmentId: own.id })
          .pipe(Effect.flip);
        const missing = yield* service
          .read({ userId: alice, attachmentId: uuidv7() })
          .pipe(Effect.flip);

        return {
          unclaimed: new TextDecoder().decode(unclaimed.bytes),
          claimed: new TextDecoder().decode(claimed.bytes),
          fileName: claimed.fileName,
          mediaType: claimed.mediaType,
          strangerBeforeClaim: strangerBeforeClaim._tag,
          // A stranger gets the same answer whether it exists or not.
          strangerAfterClaim: strangerAfterClaim._tag,
          missing: missing._tag,
        };
      }),
    );

    expect(result).toEqual({
      unclaimed: "private words",
      claimed: "private words",
      fileName: "note.txt",
      mediaType: "text/plain",
      strangerBeforeClaim: "AttachmentNotAvailable",
      strangerAfterClaim: "AttachmentNotAvailable",
      missing: "AttachmentNotAvailable",
    });
  });

  it("only lets the owner delete an unclaimed upload", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* AttachmentService;
        const repo = yield* ChatRepo;
        const alice = yield* makeUser();
        const bob = yield* makeUser();
        const target = yield* upload(alice, "a.txt", "a");
        const claimedLater = yield* upload(alice, "b.txt", "b");

        const stranger = yield* service
          .remove({ userId: bob, attachmentId: target.id })
          .pipe(Effect.flip);

        yield* repo.createTurn({
          userId: alice,
          conversationId: null,
          modelId,
          content: "sent",
          attachmentIds: [claimedLater.id],
        });
        const alreadyClaimed = yield* service
          .remove({ userId: alice, attachmentId: claimedLater.id })
          .pipe(Effect.flip);

        yield* service.remove({ userId: alice, attachmentId: target.id });

        return {
          stranger: stranger._tag,
          alreadyClaimed: alreadyClaimed._tag,
          remaining: yield* attachmentCount(alice),
        };
      }),
    );

    expect(result).toEqual({
      stranger: "AttachmentNotAvailable",
      alreadyClaimed: "AttachmentNotAvailable",
      remaining: 1,
    });
  });
});

describe("attachment cleanup", () => {
  it("sweeps abandoned uploads but keeps fresh and claimed ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* ChatRepo;
        const attachmentRepo = yield* AttachmentRepo;
        const store = yield* BlobStore;
        const userId = yield* makeUser();
        const abandoned = yield* upload(userId, "abandoned.txt", "abandoned");
        // Uploaded but never sent, and still inside the grace period.
        yield* upload(userId, "fresh.txt", "fresh");
        const claimed = yield* upload(userId, "claimed.txt", "claimed");

        yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId,
          content: "sent",
          attachmentIds: [claimed.id],
        });

        // Backdate the abandoned upload past the grace period.
        yield* db
          .update(attachments)
          .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
          .where(eq(attachments.id, abandoned.id));
        const abandonedKey = (yield* attachmentRepo.listWithBlobsByIds(userId, [abandoned.id]))[0]!
          .storageKey;

        const service = yield* AttachmentService;
        const keys = yield* attachmentRepo.sweepUnclaimed(new Date(Date.now() - 60 * 60 * 1000));
        yield* service.deleteBlobs(keys);

        const left = yield* db.select().from(attachments).where(eq(attachments.userId, userId));
        return {
          swept: [...keys],
          abandonedKey,
          bytesGone: !(yield* store.exists(abandonedKey)),
          left: left.map((row) => row.fileName).sort(),
        };
      }),
    );

    expect(result.swept).toEqual([result.abandonedKey]);
    expect(result.bytesGone).toBe(true);
    expect(result.left).toEqual(["claimed.txt", "fresh.txt"]);
  });

  it("purges one user's files without touching another's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* AttachmentService;
        const store = yield* BlobStore;
        const leaving = yield* makeUser();
        const staying = yield* makeUser();
        yield* upload(leaving, "one.txt", "one");
        yield* upload(leaving, "two.txt", "two");
        yield* upload(staying, "keep.txt", "keep");
        const leavingKeys = (yield* blobsOf(leaving)).map((row) => row.storageKey);
        const stayingKey = (yield* blobsOf(staying))[0]!.storageKey;

        yield* service.purgeUserFiles(leaving);

        const leavingStill = yield* Effect.forEach(leavingKeys, (key) => store.exists(key));
        return {
          prefix: userBlobPrefix(leaving),
          leavingGone: leavingStill.every((exists) => !exists),
          stayingKept: yield* store.exists(stayingKey),
        };
      }),
    );

    expect(result.leavingGone).toBe(true);
    expect(result.stayingKept).toBe(true);
  });
});

describe("attachment-related migration state", () => {
  it("defaults new models to no native file input and seeds the local parser", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const existing = yield* db.select().from(models).where(eq(models.id, modelId));
        const inserted = yield* db
          .insert(models)
          .values({
            id: uuidv7(),
            providerId: existing[0]!.providerId,
            modelKey: "m",
            displayName: "M",
            type: "chat",
          })
          .returning();
        const parser = yield* db.select().from(tools).where(eq(tools.name, "document_parser"));
        return { capabilities: inserted[0]!.capabilities, parser: parser[0] };
      }),
    );

    expect(result.capabilities).toEqual({
      reasoning: false,
      tools: false,
      vision: false,
      files: false,
    });
    expect(result.parser).toMatchObject({ kind: "local", enabled: true });
    expect(result.parser?.config).toMatchObject({ maxChars: 120_000, maxPages: 200 });
  });
});
