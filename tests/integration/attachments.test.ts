import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import {
  messageChunks,
  attachmentBlobs,
  attachments,
  conversations,
  models,
  tools,
  user,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeDocumentVersions,
} from "~/db/schema/index.ts";
import {
  BlobStore,
  blobStorageKey,
  userBlobPrefix,
} from "~/modules/attachments/server/blob-store.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { acceptGeneratedImage } from "~/modules/chat/server/generated-images.ts";
import { GenerationFence } from "~/modules/chat/server/generation-fence.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { Db } from "~/server/db.ts";
import { POSTGRES_IMAGE } from "./postgres-image.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "attachments-it-"));

let container: StartedPostgreSqlContainer;
/** messages.model_id and conversations.model_id are real FKs. */
let modelId: string;
let runtime: ManagedRuntime.ManagedRuntime<
  AttachmentRepo | AttachmentService | BlobStore | ChatRepo | Db,
  unknown
>;

beforeAll(async () => {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
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
  it("purges a deleted owner's retained knowledge files without touching another owner's bytes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const owner = yield* makeUser();
        const other = yield* makeUser();
        const db = yield* Db;
        const store = yield* BlobStore;
        const service = yield* AttachmentService;
        yield* upload(owner, "source.txt", "shared with retained knowledge versions");
        yield* upload(other, "source.txt", "shared with retained knowledge versions");
        const owned = (yield* blobsOf(owner))[0]!;
        const unrelated = (yield* blobsOf(other))[0]!;
        const collectionId = uuidv7();
        const documentId = uuidv7();
        const versionId = uuidv7();
        yield* db
          .insert(knowledgeCollections)
          .values({ id: collectionId, userId: owner, name: "Owned files" });
        yield* db
          .insert(knowledgeDocuments)
          .values({ id: documentId, collectionId, title: "Source", kind: "file" });
        yield* db.insert(knowledgeDocumentVersions).values([
          { id: versionId, documentId, revision: 1, kind: "file", blobId: owned.id },
          { id: uuidv7(), documentId, revision: 2, kind: "file", blobId: owned.id },
        ]);
        yield* db
          .update(knowledgeDocuments)
          .set({ currentVersionId: versionId })
          .where(eq(knowledgeDocuments.id, documentId));
        yield* db.delete(user).where(eq(user.id, owner));
        yield* service.purgeUserFiles(owner);
        return {
          ownedGone: !(yield* store.exists(owned.storageKey)),
          otherSurvives: yield* store.exists(unrelated.storageKey),
          orphanRows: (yield* db
            .select()
            .from(knowledgeDocumentVersions)
            .where(eq(knowledgeDocumentVersions.documentId, documentId))).length,
        };
      }),
    );
    expect(result).toEqual({ ownedGone: true, otherSurvives: true, orphanRows: 0 });
  });

  it("a delayed last-reference deletion cannot delete reuploaded bytes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const repo = yield* AttachmentRepo;
        const service = yield* AttachmentService;
        const store = yield* BlobStore;
        const first = yield* upload(userId, "first.txt", "incarnation race");
        const [before] = yield* blobsOf(userId);
        // Commit row removal, but deliberately delay physical cleanup.
        const obsoleteKeys = yield* repo.deleteUnclaimed(userId, first.id);
        const second = yield* upload(userId, "again.txt", "incarnation race");
        const [after] = yield* blobsOf(userId);
        yield* service.deleteBlobs(obsoleteKeys);
        const read = yield* service.read({ userId, attachmentId: second.id });
        return {
          differentKeys: before!.storageKey !== after!.storageKey,
          oldGone: !(yield* store.exists(before!.storageKey)),
          content: new TextDecoder().decode(read.bytes),
        };
      }),
    );
    expect(result).toEqual({ differentKeys: true, oldGone: true, content: "incarnation race" });
  });

  it("concurrent dedup losers delete only their own candidate objects", async () => {
    const userId = await run(makeUser());
    const uploaded = await run(
      Effect.all(
        Array.from({ length: 8 }, (_, i) => upload(userId, `copy-${i}.txt`, "concurrent bytes")),
        { concurrency: 8 },
      ),
    );
    const blobs = await run(blobsOf(userId));
    expect(blobs).toHaveLength(1);
    expect(new Set(uploaded.map((item) => item.id)).size).toBe(8);
    const objects = readdirSync(join(process.env.BLOB_STORE_ROOT!, userBlobPrefix(userId)), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    expect(objects).toHaveLength(1);
    for (const item of uploaded) {
      const read = await run(
        Effect.flatMap(AttachmentService, (service) =>
          service.read({ userId, attachmentId: item.id }),
        ),
      );
      expect(new TextDecoder().decode(read.bytes)).toBe("concurrent bytes");
    }
  });
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

describe("durable blob cleanup", () => {
  it("removes bytes whose registration never committed, and keeps bytes that did", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const store = yield* BlobStore;
        const repo = yield* AttachmentRepo;
        const service = yield* AttachmentService;

        // A crashed upload: bytes stored under a recorded candidate whose row
        // never landed. Nothing that follows rows could ever find this object.
        const stranded = blobStorageKey(userId, "a".repeat(64));
        yield* repo.recordBlobCandidate(stranded);
        yield* store.put(stranded, bytes("orphaned by a lost commit"));

        // A registration that committed even though its caller saw a failure:
        // the intent is still pending, but a row owns the key.
        const registered = yield* upload(userId, "kept.txt", "registration committed");
        const ownedKey = (yield* blobsOf(userId)).find(
          (blob) => blob.storageKey !== stranded,
        )!.storageKey;
        yield* repo.recordBlobCandidate(ownedKey);

        // Both are past the in-flight grace period.
        yield* db.execute(
          `update blob_cleanup_intents set created_at = now() - interval '1 hour'` as never,
        );
        const claimed = yield* repo.claimBlobCleanup({
          limit: 10,
          candidateCutoff: new Date(),
          retryAfter: new Date(Date.now() + 60_000),
        });
        yield* service.deleteBlobs(claimed);

        const intents = yield* db.execute(
          `select storage_key, attempts from blob_cleanup_intents` as never,
        );
        return {
          claimed,
          strandedGone: !(yield* store.exists(stranded)),
          ownedKept: yield* store.exists(ownedKey),
          registered: registered.id,
          intents: (intents as unknown as { rows: ReadonlyArray<unknown> }).rows,
        };
      }),
    );
    // Only the unowned key is deletable; ownership, not the caller's error, decides.
    expect(result.claimed).toHaveLength(1);
    expect(result.strandedGone).toBe(true);
    expect(result.ownedKept).toBe(true);
    // Both decisions are settled, so nothing is reconsidered forever.
    expect(result.intents).toEqual([]);
  });

  it("finishes a committed last-reference deletion whose bytes outlived the crash", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const store = yield* BlobStore;
        const repo = yield* AttachmentRepo;
        const service = yield* AttachmentService;
        const uploaded = yield* upload(userId, "notes.txt", "deleted without its bytes");
        const key = (yield* blobsOf(userId))[0]!.storageKey;

        // The transaction that removed the last reference commits, and the
        // process dies before the post-commit delete: the row is gone but the
        // object remains, and only the recorded intent still knows the key.
        const orphaned = yield* repo.deleteUnclaimed(userId, uploaded.id);
        expect(orphaned).toEqual([key]);
        expect(yield* store.exists(key)).toBe(true);

        const pending = yield* db.execute(
          `select kind from blob_cleanup_intents where storage_key = '${key}'` as never,
        );
        // An orphan is due immediately: the row is already gone.
        const claimed = yield* repo.claimBlobCleanup({
          limit: 10,
          candidateCutoff: new Date(Date.now() - 60_000),
          retryAfter: new Date(Date.now() + 60_000),
        });
        yield* service.deleteBlobs(claimed);
        const remaining = yield* db.execute(
          `select storage_key from blob_cleanup_intents` as never,
        );
        return {
          pending: (pending as unknown as { rows: ReadonlyArray<{ kind: string }> }).rows,
          claimed,
          gone: !(yield* store.exists(key)),
          remaining: (remaining as unknown as { rows: ReadonlyArray<unknown> }).rows,
        };
      }),
    );
    expect(result.pending).toEqual([{ kind: "orphan" }]);
    expect(result.claimed).toHaveLength(1);
    expect(result.gone).toBe(true);
    expect(result.remaining).toEqual([]);
  });

  it("backs a failing store off and retries it later without losing the key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const db = yield* Db;
        const repo = yield* AttachmentRepo;
        const key = blobStorageKey(userId, "b".repeat(64));
        yield* repo.recordBlobCandidate(key);
        yield* db.execute(
          `update blob_cleanup_intents set created_at = now() - interval '1 hour'` as never,
        );
        // First claim hands the key over and defers it.
        const first = yield* repo.claimBlobCleanup({
          limit: 10,
          candidateCutoff: new Date(),
          retryAfter: new Date(Date.now() + 3_600_000),
        });
        // A concurrent pass must not take the same key while it is deferred.
        const second = yield* repo.claimBlobCleanup({
          limit: 10,
          candidateCutoff: new Date(),
          retryAfter: new Date(Date.now() + 3_600_000),
        });
        const row = yield* db.execute(
          `select attempts from blob_cleanup_intents where storage_key = '${key}'` as never,
        );
        return {
          first,
          second,
          attempts: (row as unknown as { rows: ReadonlyArray<{ attempts: number }> }).rows[0],
        };
      }),
    );
    expect(result.first).toHaveLength(1);
    expect(result.second).toEqual([]);
    // The intent survives the failure; nothing is dropped on the floor.
    expect(result.attempts).toEqual({ attempts: 1 });
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
          expectedMessages: yield* repo.listMessages(turn.conversation.id),
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
          expectedMessages: yield* repo.listMessages(turn.conversation.id),
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

describe("generated assistant image transactions", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=",
    "base64",
  );
  it("atomically links private bytes and ref-only chunks, then fences every stale retry write", async () => {
    await run(
      Effect.gen(function* () {
        const userId = yield* makeUser();
        const other = yield* makeUser();
        const repo = yield* ChatRepo;
        const service = yield* AttachmentService;
        const db = yield* Db;
        const turn = yield* repo.createTurn({
          userId,
          conversationId: null,
          modelId,
          content: "draw",
          attachmentIds: [],
        });
        const fence = {
          userId,
          conversationId: turn.conversation.id,
          messageId: turn.assistant.id,
          generationId: turn.assistant.generationId!,
        };
        const input = {
          fence,
          mediaType: "image/png",
          data: png,
          textOffset: 0,
          turnIndex: 0,
          eventIndex: 1,
          callIndex: 0,
          seq: 1,
        };
        const image = yield* acceptGeneratedImage(service, input);
        const stored = yield* repo.getMessage(turn.assistant.id);
        expect(stored?.assistantOutput?.images).toEqual([image]);
        const chunks = yield* db
          .select()
          .from(messageChunks)
          .where(eq(messageChunks.messageId, turn.assistant.id));
        expect(chunks).toHaveLength(1);
        expect(JSON.parse(chunks[0]!.delta)).toEqual(image);
        expect(JSON.stringify(chunks)).not.toContain(png.toString("base64"));
        expect(
          Buffer.from(
            (yield* service.read({ userId, attachmentId: image.attachment.id })).bytes,
          ).equals(png),
        ).toBe(true);
        expect(
          (yield* Effect.result(service.read({ userId: other, attachmentId: image.attachment.id })))
            ._tag,
        ).toBe("Failure");
        yield* repo
          .finalizeMessage({ messageId: turn.assistant.id, status: "aborted", content: "" })
          .pipe(Effect.provideService(GenerationFence, fence));
        const branch = yield* repo.cloneConversationPrefix({
          userId,
          sourceConversationId: turn.conversation.id,
          throughMessageId: turn.assistant.id,
        });
        const cloned = (yield* repo.listMessages(branch.id)).find(
          (message) => message.role === "assistant",
        )!;
        const clonedImage = cloned.assistantOutput!.images[0]!;
        expect(cloned.generationId).toBeNull();
        expect(clonedImage.attachment.id).not.toBe(image.attachment.id);
        expect(clonedImage).toMatchObject({
          textOffset: image.textOffset,
          turnIndex: image.turnIndex,
        });
        const retry = yield* repo.resetMessageForRetry({
          expectedMessages: yield* repo.listMessages(turn.conversation.id),
          userId,
          messageId: turn.assistant.id,
          modelId,
          deleteMessageIds: [],
          invalidateCheckpointThroughMessageIds: [],
        });
        expect(retry.generationId).not.toBe(fence.generationId);
        const replay = { v: 1 as const, providerId: "synthetic", modelKey: "synthetic", turns: [] };
        const writes = [
          repo.appendChunks(turn.assistant.id, [{ seq: 1, kind: "text", delta: "stale" }]),
          repo.saveProviderReplay(turn.assistant.id, replay),
          repo.finalizeMessage({
            messageId: turn.assistant.id,
            status: "complete",
            content: "stale",
          }),
          acceptGeneratedImage(service, input),
        ];
        for (const write of writes)
          expect(
            (yield* Effect.exit(write.pipe(Effect.provideService(GenerationFence, fence))))._tag,
          ).toBe("Failure");
        const current = yield* repo.getMessage(turn.assistant.id);
        expect(current).toMatchObject({
          status: "streaming",
          content: "",
          assistantOutput: null,
          providerReplay: null,
          generationId: retry.generationId,
        });
        expect(yield* attachmentCount(userId)).toBe(1);
        expect(
          yield* db
            .select()
            .from(messageChunks)
            .where(eq(messageChunks.messageId, turn.assistant.id)),
        ).toHaveLength(0);
        yield* service.deleteBlobs(retry.orphanedKeys);
        expect(
          Buffer.from(
            (yield* service.read({ userId, attachmentId: clonedImage.attachment.id })).bytes,
          ).equals(png),
        ).toBe(true);
        yield* service.deleteBlobs(yield* repo.deleteConversation(userId, branch.id));
        expect(yield* attachmentCount(userId)).toBe(0);
        expect(
          (yield* Effect.result(service.read({ userId, attachmentId: clonedImage.attachment.id })))
            ._tag,
        ).toBe("Failure");
      }),
    );
  });
});
