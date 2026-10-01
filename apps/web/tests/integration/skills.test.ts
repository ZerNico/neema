import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import {
  user,
  skillRevisions,
  skillFiles,
  attachmentBlobs,
  conversations,
  messages,
  messageSkills,
} from "~/db/schema/index.ts";
import { SkillRepo, resolveSkillManifest } from "~/modules/skills/server/repo.ts";
import { SkillService } from "~/modules/skills/server/service.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { BlobStoreError } from "~/modules/attachments/errors.ts";
import { SharingService } from "~/modules/sharing/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { SkillFile } from "~/modules/skills/package.ts";
import { makeToolFileResolver } from "~/modules/chat/server/tool-files.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { Option } from "effect";
import { createTestDatabase, type TestDatabase } from "./database.ts";

// The preview routes run on the app's runtime; here that is this file's own.
vi.mock("~/server/runtime.ts", () => ({
  runtime: { runPromise: (effect: Effect.Effect<unknown>) => runtime.runPromise(effect) },
}));

const blobs = new Map<string, Uint8Array>();
const MemoryBlobs = Layer.succeed(
  BlobStore,
  BlobStore.of({
    put: (key, bytes) =>
      Effect.sync(() => {
        blobs.set(key, bytes);
      }),
    get: (key) =>
      blobs.has(key)
        ? Effect.succeed(blobs.get(key)!)
        : Effect.fail(
            new BlobStoreError({ operation: "get", key, message: "Missing fixture blob" }),
          ),
    delete: (key) =>
      Effect.sync(() => {
        blobs.delete(key);
      }),
    exists: (key) => Effect.succeed(blobs.has(key)),
    deletePrefix: () => Effect.void,
  }),
);
const QuietSync = Layer.succeed(
  SyncBus,
  SyncBus.of({
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  }),
);
let database: TestDatabase;
type Services =
  | Db
  | SkillRepo
  | SkillService
  | SkillReader
  | SharingService
  | AttachmentRepo
  | AttachmentService
  | BlobStore;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const newUser = async () => {
  const id = uuidv7();
  await run(
    Effect.flatMap(Db, (db) =>
      db.insert(user).values({ id, name: "Skill test", email: `${id}@test.invalid` }),
    ),
  );
  return id;
};
const files = (body: string): SkillFile[] => [
  { path: "SKILL.md", content: `---\nname: review\ndescription: Review carefully\n---\n${body}` },
  { path: "references/check.md", content: "Supporting guidance" },
];
const save = (owner: string, body: string, skillId?: string, expectedRevision?: number) =>
  run(
    Effect.flatMap(SkillService, (service) =>
      service.save(owner, {
        files: files(body),
        ...(skillId ? { skillId } : {}),
        ...(expectedRevision ? { expectedRevision } : {}),
      }),
    ),
  );
const manifest = (owner: string, explicit: string[], attached: string[] = []) =>
  run(
    Effect.flatMap(Db, (db) =>
      db.transaction((tx) => resolveSkillManifest(tx, owner, explicit, attached)),
    ),
  );
beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;
  const infra = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  const repos = Layer.mergeAll(SkillRepo.layer, AttachmentRepo.layer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infra),
  );
  const base = Layer.mergeAll(repos, MemoryBlobs, QuietSync);
  const app = Layer.mergeAll(SkillService.layer, SkillReader.layer, SharingService.layer).pipe(
    Layer.provideMerge(AttachmentService.layer),
    Layer.provideMerge(base),
  );
  runtime = ManagedRuntime.make(app);
}, 240000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

describe("portable skill storage and ACLs", () => {
  it("round-trips exact source files without exposing bodies through metadata", async () => {
    const owner = await newUser();
    const id = await save(owner, "Private root");
    const detail = await run(Effect.flatMap(SkillService, (service) => service.detail(owner, id)));
    expect(detail.files).toEqual(files("Private root"));
    const metadata = await run(Effect.flatMap(SkillRepo, (repo) => repo.get(owner, id)));
    expect(metadata).not.toHaveProperty("files");
    expect(JSON.stringify(metadata)).not.toContain("Private root");
    const stored = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(skillFiles).where(eq(skillFiles.revisionId, detail.revisionId)),
      ),
    );
    expect(stored).toHaveLength(2);
  });
  it("allows recipient execution but never recipient editor reads or updates", async () => {
    const owner = await newUser(),
      recipient = await newUser();
    const id = await save(owner, "Owner guidance");
    await expect(manifest(recipient, [id])).rejects.toThrow();
    await run(
      Effect.flatMap(SharingService, (sharing) =>
        sharing.change(
          owner,
          { kind: "skill", id },
          { action: "email", email: `${recipient}@test.invalid` },
        ),
      ),
    );
    const [pinned] = await manifest(recipient, [id]);
    expect(
      await run(
        Effect.flatMap(SkillReader, (reader) => reader.readPinned(recipient, pinned!, "SKILL.md")),
      ),
    ).toMatchObject({ kind: "text", content: expect.stringContaining("Owner guidance") });
    await expect(
      run(Effect.flatMap(SkillService, (service) => service.detail(recipient, id))),
    ).rejects.toThrow();
    await expect(save(recipient, "Hijack", id, 1)).rejects.toThrow();
    await run(
      Effect.flatMap(SharingService, (sharing) =>
        sharing.change(owner, { kind: "skill", id }, { action: "revokeUser", userId: recipient }),
      ),
    );
    await expect(
      run(
        Effect.flatMap(SkillReader, (reader) => reader.readPinned(recipient, pinned!, "SKILL.md")),
      ),
    ).rejects.toThrow();
  });
  it("resolves current revisions but keeps an active attempt pinned and preserves explicit overlap", async () => {
    const owner = await newUser();
    const id = await save(owner, "Version one");
    const [first] = await manifest(owner, [id], [id]);
    expect(first?.explicit).toBe(true);
    // Real attempts hold durable revision references, not merely an in-memory ID.
    await run(
      Effect.flatMap(Db, (db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const conversationId = uuidv7(),
              messageId = uuidv7();
            yield* tx.insert(conversations).values({ id: conversationId, userId: owner });
            yield* tx
              .insert(messages)
              .values({ id: messageId, conversationId, role: "assistant", status: "streaming" });
            yield* tx.insert(messageSkills).values({
              messageId,
              skillId: id,
              revisionId: first!.revisionId,
              explicit: true,
              position: 0,
            });
          }),
        ),
      ),
    );
    await save(owner, "Version two", id, 1);
    const [next] = await manifest(owner, [id], [id]);
    expect(next?.revisionId).not.toBe(first?.revisionId);
    expect(
      await run(
        Effect.flatMap(SkillReader, (reader) => reader.readPinned(owner, first!, "SKILL.md")),
      ),
    ).toMatchObject({ kind: "text", content: expect.stringContaining("Version one") });
    expect(
      await run(
        Effect.flatMap(SkillReader, (reader) => reader.readPinned(owner, next!, "SKILL.md")),
      ),
    ).toMatchObject({ kind: "text", content: expect.stringContaining("Version two") });
    await expect(save(owner, "Stale editor", id, 1)).rejects.toThrow();
    expect(
      (await run(Effect.flatMap(SkillService, (service) => service.detail(owner, id)))).files,
    ).toEqual(files("Version two"));
  });
  it("stores upstream baseline separately when a local conflict is kept", async () => {
    const owner = await newUser();
    const source = {
      url: "https://github.com/example/skills",
      repository: "example/skills",
      path: "",
      commit: "a".repeat(40),
      contentHash: "test",
    };
    const id = await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, { files: files("upstream-v1"), source }),
      ),
    );
    await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          skillId: id,
          expectedRevision: 1,
          files: files("local choice"),
          upstreamBaseline: files("upstream-v2"),
          source: { ...source, commit: "b".repeat(40) },
        }),
      ),
    );
    expect(
      await run(Effect.flatMap(SkillService, (service) => service.baseline(owner, id))),
    ).toEqual(files("upstream-v2"));
    expect(
      (await run(Effect.flatMap(SkillService, (service) => service.detail(owner, id)))).files,
    ).toEqual(files("local choice"));
    const rows = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(skillRevisions).where(eq(skillRevisions.skillId, id)),
      ),
    );
    expect(rows).toHaveLength(2);
  });
  it("refuses a stale or over-quota save before storing any bytes", async () => {
    const owner = await newUser();
    const id = await save(owner, "Quota baseline");
    const stored = blobs.size;
    await expect(save(owner, "Stale write", id, 1)).resolves.toBeTruthy();
    const afterValid = blobs.size;
    // A conflicting expected revision and an exhausted account quota must both
    // fail admission, which happens before candidate bytes reach the store.
    await expect(save(owner, "Rejected by conflict", id, 1)).rejects.toThrow();
    expect(blobs.size).toBe(afterValid);
    expect(afterValid).toBeGreaterThan(stored - 1);
    // Quota counts stored bytes once, however many revisions share them. A
    // 200 MiB file two skills both reference is 200 MiB, not 400.
    const MiB = 1024 * 1024;
    const seed = (size: number, skillIds: string[]) =>
      run(
        Effect.gen(function* () {
          const db = yield* Db;
          const blobId = uuidv7();
          const sha256 = uuidv7().replaceAll("-", "").padEnd(64, "0");
          yield* db.insert(attachmentBlobs).values({
            id: blobId,
            userId: owner,
            sha256,
            storageKey: `quota-fixture/${blobId}`,
            size,
            mediaType: "application/octet-stream",
          });
          for (const skillId of skillIds) {
            const [revision] = yield* db
              .select({ id: skillRevisions.id })
              .from(skillRevisions)
              .where(eq(skillRevisions.skillId, skillId));
            yield* db.insert(skillFiles).values({
              revisionId: revision!.id,
              path: `assets/${blobId}.bin`,
              blobId,
              byteSize: size,
              sha256,
              mediaType: "application/octet-stream",
            });
          }
        }),
      );
    const other = await save(owner, "Second skill");
    const current = await run(Effect.flatMap(SkillService, (service) => service.detail(owner, id)));
    await seed(200 * MiB, [other, id]);
    // Still room: the shared file counts once.
    await expect(save(owner, "Fits beside the shared file")).resolves.toBeTruthy();
    expect(current.revision).toBeGreaterThan(0);
    await seed(60 * MiB, [other]);
    const before = blobs.size;
    expect(
      await run(
        Effect.flip(
          Effect.flatMap(SkillService, (service) =>
            service.save(owner, { files: files("Over the quota") }),
          ),
        ),
      ),
    ).toMatchObject({
      _tag: "SkillRejected",
      reason: expect.stringContaining("quota"),
    });
    expect(blobs.size).toBe(before);
  });
  it("keeps a revision referenced by history readable after the skill is soft deleted", async () => {
    const owner = await newUser();
    const id = await save(owner, "Referenced by an answer");
    const [pinned] = await manifest(owner, [id]);
    await run(
      Effect.flatMap(Db, (db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            const conversationId = uuidv7(),
              messageId = uuidv7();
            yield* tx.insert(conversations).values({ id: conversationId, userId: owner });
            yield* tx
              .insert(messages)
              .values({ id: messageId, conversationId, role: "assistant", status: "complete" });
            yield* tx.insert(messageSkills).values({
              messageId,
              skillId: id,
              revisionId: pinned!.revisionId,
              explicit: true,
              position: 0,
            });
          }),
        ),
      ),
    );
    await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
    // The skill is gone for new attempts, but the answer's evidence is intact.
    await expect(manifest(owner, [id])).rejects.toThrow();
    const rows = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(skillFiles).where(eq(skillFiles.revisionId, pinned!.revisionId)),
      ),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(
        blobs.has(
          (
            await run(
              Effect.flatMap(Db, (db) =>
                db.select().from(attachmentBlobs).where(eq(attachmentBlobs.id, row.blobId)),
              ),
            )
          )[0]!.storageKey,
        ),
      ).toBe(true);
  });
  it("soft deletes unavailable skills and cleans unreferenced imported baseline blobs", async () => {
    const owner = await newUser();
    const id = await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          files: files("Disposable"),
          source: {
            url: "https://github.com/example/skills",
            repository: "example/skills",
            path: "",
            commit: "a".repeat(40),
            contentHash: "test",
          },
        }),
      ),
    );
    await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
    await expect(manifest(owner, [id])).rejects.toThrow();
    expect(
      await run(
        Effect.flatMap(Db, (db) =>
          db.select().from(skillRevisions).where(eq(skillRevisions.skillId, id)),
        ),
      ),
    ).toEqual([]);
    expect(
      await run(
        Effect.flatMap(Db, (db) =>
          db.select().from(attachmentBlobs).where(eq(attachmentBlobs.userId, owner)),
        ),
      ),
    ).toEqual([]);
  });
});

const upload = (owner: string, bytes: Uint8Array, fileName: string) =>
  run(
    Effect.flatMap(AttachmentService, (service) =>
      service.upload({ userId: owner, fileName, declaredMediaType: "", bytes }),
    ),
  );

describe("binary files in skills", () => {
  const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const deck = new Uint8Array([80, 75, 3, 4, ...Array.from({ length: 60 }, (_, i) => i)]);
  const root = {
    path: "SKILL.md",
    content: "---\nname: brand\ndescription: Our deck\n---\nUse assets/master.pptx",
  };

  it("takes an upload over, keeps it by hash across revisions and serves it by hash", async () => {
    const owner = await newUser();
    const uploaded = await upload(owner, deck, "master.pptx");
    const id = await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          files: [
            root,
            // The client's claim about size and type is ignored for the stored bytes.
            {
              path: "assets/master.pptx",
              binary: { size: 1, mediaType: "text/html", uploadId: uploaded.id },
            },
          ],
        }),
      ),
    );
    const detail = await run(Effect.flatMap(SkillService, (service) => service.detail(owner, id)));
    const sha256 = sha256Hex(deck);
    expect(detail.files).toContainEqual({
      path: "assets/master.pptx",
      binary: { size: deck.length, mediaType: PPTX, sha256 },
    });
    // The upload's own row is spent; its bytes now belong to the skill.
    expect(
      await run(
        Effect.flatMap(AttachmentRepo, (repo) => repo.listWithBlobsByIds(owner, [uploaded.id])),
      ),
    ).toEqual([]);
    const [row] = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(skillFiles).where(eq(skillFiles.revisionId, detail.revisionId)),
      ),
    ).then((rows) => rows.filter((file) => file.path === "assets/master.pptx"));
    expect(row).toMatchObject({ mediaType: PPTX, byteSize: deck.length, sha256 });

    // A text edit keeps the binary by its hash, under a new path too.
    await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          skillId: id,
          expectedRevision: detail.revision,
          files: [
            { ...root, content: `${root.content}\nUpdated.` },
            { path: "templates/master.pptx", binary: { size: 0, mediaType: "x", sha256 } },
          ],
        }),
      ),
    );
    const read = await run(
      Effect.flatMap(SkillService, (service) => service.readFile(owner, id, sha256)),
    );
    expect(read.path).toBe("templates/master.pptx");
    expect(Buffer.from(read.bytes).equals(Buffer.from(deck))).toBe(true);

    // The Office preview routes open it the same way, for its owner only.
    const { openPreviewFile } = await import("~/server/office-preview.ts");
    expect(await openPreviewFile(owner, "skill-file", `${id}:${sha256}`)).toMatchObject({
      name: "master.pptx",
      mediaType: PPTX,
      sha256,
    });
    expect(await openPreviewFile(await newUser(), "skill-file", `${id}:${sha256}`)).toBeNull();
    expect(await openPreviewFile(owner, "skill-file", `${id}:not-a-hash`)).toBeNull();

    // A hash this skill never stored cannot be kept.
    expect(
      await run(
        Effect.flip(
          Effect.flatMap(SkillService, (service) =>
            service.save(owner, {
              skillId: id,
              expectedRevision: detail.revision + 1,
              files: [
                root,
                { path: "x.bin", binary: { size: 1, mediaType: "x", sha256: "e".repeat(64) } },
              ],
            }),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "SkillRejected", reason: expect.stringContaining("upload it again") });

    // Removing the skill releases the bytes.
    const key = (
      await run(
        Effect.flatMap(Db, (db) =>
          db.select().from(attachmentBlobs).where(eq(attachmentBlobs.sha256, sha256)),
        ),
      )
    )[0]!.storageKey;
    expect(blobs.has(key)).toBe(true);
    await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
    expect(blobs.has(key)).toBe(false);
  });

  it("opens a skill file for tools only at the revision this answer was offered", async () => {
    const owner = await newUser();
    const id = await run(
      Effect.flatMap(SkillService, (service) =>
        service.save(owner, {
          files: [
            root,
            {
              path: "assets/master.pptx",
              binary: { size: deck.length, mediaType: PPTX },
              bytes: deck,
            },
          ],
        }),
      ),
    );
    const [entry] = await manifest(owner, [id]);
    const resolver = await run(
      Effect.gen(function* () {
        const reader = yield* SkillReader;
        return makeToolFileResolver({
          db: yield* Db,
          store: yield* BlobStore,
          projectFiles: Option.none(),
          userId: owner,
          conversationId: uuidv7(),
          projectId: null,
          skills: { entries: [entry!], reader },
        });
      }),
    );
    const ref = `skill:${entry!.revisionId}/assets/master.pptx`;
    const file = await run(resolver.resolve(ref));
    expect(file).toMatchObject({
      name: "master.pptx",
      mediaType: PPTX,
      source: { kind: "skill", revisionId: entry!.revisionId, path: "assets/master.pptx" },
    });
    expect(Buffer.from(file.bytes).equals(Buffer.from(deck))).toBe(true);
    await expect(run(resolver.resolve(`skill:${uuidv7()}/assets/master.pptx`))).rejects.toThrow(
      /read the file again/,
    );
    await expect(
      run(resolver.resolve(`skill:${entry!.revisionId}/assets/other.pptx`)),
    ).rejects.toThrow(/No file/);
    // Someone else cannot open it, even holding the exact reference.
    const stranger = await newUser();
    const theirs = await run(
      Effect.gen(function* () {
        const reader = yield* SkillReader;
        return makeToolFileResolver({
          db: yield* Db,
          store: yield* BlobStore,
          projectFiles: Option.none(),
          userId: stranger,
          conversationId: uuidv7(),
          projectId: null,
          skills: { entries: [entry!], reader },
        });
      }),
    );
    await expect(run(theirs.resolve(ref))).rejects.toThrow();
    expect(await run(theirs.authorize(ref))).toBe(false);
    // A draft opened from it stays usable while the skill is readable.
    expect(await run(resolver.authorize(ref))).toBe(true);
    await run(Effect.flatMap(SkillService, (service) => service.remove(owner, id)));
    expect(await run(resolver.authorize(ref))).toBe(false);
  });
});
