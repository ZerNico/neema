import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { createTestDatabase, type TestDatabase } from "./database.ts";

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
type Services = Db | SkillRepo | SkillService | SkillReader | SharingService | AttachmentRepo;
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
    ).toContain("Owner guidance");
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
    ).toContain("Version one");
    expect(
      await run(
        Effect.flatMap(SkillReader, (reader) => reader.readPinned(owner, next!, "SKILL.md")),
      ),
    ).toContain("Version two");
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
    // Each package is individually valid; only the account total exceeds the quota.
    const bulk = "x".repeat(250_000);
    const large = Effect.flatMap(SkillService, (service) =>
      service.save(owner, {
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: review\ndescription: Review carefully\n---\nBulk",
          },
          ...Array.from({ length: 39 }, (_, index) => ({
            path: `references/file-${index}.md`,
            content: bulk,
          })),
        ],
      }),
    );
    for (let attempt = 0; attempt < 10; attempt++) await run(large).catch(() => null);
    const before = blobs.size;
    expect(await run(Effect.flip(large))).toMatchObject({
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
