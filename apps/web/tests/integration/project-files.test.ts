import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Stream } from "effect";
import { strToU8, zipSync } from "fflate";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentBlobs,
  blobCleanupIntents,
  conversations,
  conversationQueueEntries,
  messageAttachments,
  messages,
  projectFileVersions,
  projectFiles,
  projects,
  user,
} from "~/db/schema/index.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { makeToolFileResolver } from "~/modules/chat/server/tool-files.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { PROJECT_FILE_LIMITS } from "~/modules/projects/files.ts";
import { ProjectFileService, type FileWriter } from "~/modules/projects/server/project-files.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { FakeDocumentParser } from "./unused-services.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "project-files-it-"));

let database: TestDatabase;
type Services =
  | Db
  | ProjectService
  | ProjectFileService
  | AttachmentService
  | AttachmentRepo
  | BlobStore;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const puts: string[] = [];
let beforePut: (() => Promise<void>) | undefined;
const ObservedBlobs = Layer.effect(
  BlobStore,
  Effect.map(BlobStore, (store) =>
    BlobStore.of({
      ...store,
      put: (key, bytes) =>
        Effect.gen(function* () {
          puts.push(key);
          if (beforePut) yield* Effect.promise(beforePut);
          yield* store.put(key, bytes);
        }),
    }),
  ),
).pipe(Layer.provide(fsBlobStoreLayer));
const TestBus = Layer.succeed(SyncBus, {
  publish: () => Effect.void,
  publishGlobal: () => Effect.void,
  signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
  subscribe: () => Stream.empty,
});

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const repos = Layer.mergeAll(
    AttachmentRepo.layer,
    TestBus,
    ObservedBlobs,
    FakeDocumentParser,
  ).pipe(Layer.provideMerge(FeaturePolicy.layer), Layer.provideMerge(infrastructure));
  const attachments = AttachmentService.layer.pipe(Layer.provideMerge(repos));
  runtime = ManagedRuntime.make(
    Layer.mergeAll(ProjectService.layer, ProjectFileService.layer).pipe(
      Layer.provideMerge(attachments),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const db = <A>(body: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  run(Effect.flatMap(Db, body));
const createUser = async () => {
  const id = uuidv7();
  await db((d) => d.insert(user).values({ id, name: `User ${id.slice(-4)}`, email: `${id}@t.io` }));
  await run(seedEligibleSession(id));
  return id;
};
const files = <A, E>(body: (service: ProjectFileService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(ProjectFileService, body));
const person = (userId: string): FileWriter => ({ origin: "user", userId });
const text = (value: string) => strToU8(value);
/** A project owned by `owner`, with `editor` and `viewer` members. */
const setup = async () => {
  const owner = await createUser();
  const editor = await createUser();
  const viewer = await createUser();
  const project = await run(
    Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Launch" })),
  );
  for (const [member, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Two members, in order.
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, project.id, { action: "addUser", email: `${member}@t.io`, role }),
      ),
    );
  return { owner, editor, viewer, projectId: project.id };
};
const versionRows = (fileId: string) =>
  db((d) =>
    d
      .select()
      .from(projectFileVersions)
      .where(eq(projectFileVersions.fileId, fileId))
      .orderBy(projectFileVersions.number),
  );

const heldRow = async (
  table: "projects" | "attachment_blobs",
  id: string,
  mode: "share" | "update" = "update",
) => {
  const client = new Client({ connectionString: database.url });
  await client.connect();
  await client.query("begin");
  await client.query(`select id from ${table} where id = $1 for ${mode}`, [id]);
  const { pid } = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!;
  return {
    wait: async (count: number) => {
      // A safety stop, not a wait: under a full parallel run the queue can take a while to form.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait on actual database blockers, not elapsed time.
        const result = await client.query<{ count: number }>(
          `with recursive waiters(pid) as (
            select pid from pg_stat_activity where datname = current_database() and $1::int = any(pg_blocking_pids(pid))
            union
            select a.pid from pg_stat_activity a join waiters w on w.pid = any(pg_blocking_pids(a.pid)) where a.datname = current_database()
          ) select count(*)::int as count from waiters`,
          [pid],
        );
        if (result.rows[0]!.count >= count) return;
      }
      throw new Error("Writes did not reach the held project lock");
    },
    release: async () => {
      await client.query("commit");
      await client.end();
    },
  };
};

describe("project files", () => {
  it("lets editors write, members read and download, and nobody else in", async () => {
    const { owner, editor, viewer, projectId } = await setup();
    const stranger = await createUser();
    const file = await files((s) =>
      s.write(person(owner), { projectId, name: "notes.md", bytes: text("# Plan") }),
    );
    expect(file).toMatchObject({ name: "notes.md", version: 1, mediaType: "text/plain" });
    const next = await files((s) =>
      s.write(person(editor), {
        projectId,
        fileId: file.id,
        name: "notes.md",
        bytes: text("# Plan v2"),
        basedOnVersion: 1,
      }),
    );
    expect(next.version).toBe(2);
    await expect(
      files((s) =>
        s.write(person(viewer), {
          projectId,
          fileId: file.id,
          name: "notes.md",
          bytes: text("no"),
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProjectRejected" });
    const [latest] = await files((s) => s.versions(viewer, file.id));
    expect(latest).toMatchObject({ number: 2, current: true });
    const download = await files((s) => s.download(viewer, latest!.id));
    expect(new TextDecoder().decode(download!.bytes)).toBe("# Plan v2");
    expect(await files((s) => s.download(stranger, latest!.id))).toBeNull();
    await expect(files((s) => s.list(stranger, projectId))).rejects.toMatchObject({
      _tag: "ProjectNotAvailable",
    });
  });

  it.each([
    {
      name: "pin a version",
      change: (actor: string, ids: { fileId: string; firstVersion: string }) =>
        Effect.flatMap(ProjectFileService, (s) =>
          s.pin(actor, ids.firstVersion, { pinned: true, label: "Signed off" }),
        ),
    },
    {
      name: "restore a version",
      change: (actor: string, ids: { fileId: string; firstVersion: string }) =>
        Effect.flatMap(ProjectFileService, (s) => s.restore(actor, ids.firstVersion, 2)),
    },
    {
      name: "delete the file",
      change: (actor: string, ids: { fileId: string; firstVersion: string }) =>
        Effect.flatMap(ProjectFileService, (s) => s.remove(actor, ids.fileId)),
    },
  ])(
    "lets owners and editors $name, refuses viewers and hides it from strangers",
    async ({ change }) => {
      const seen: Record<string, string> = {};
      for (const role of ["owner", "editor", "viewer", "stranger"] as const) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each role gets its own project.
        const members = await setup();
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        const stranger = await createUser();
        const actor = role === "stranger" ? stranger : members[role];
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        const file = await files((s) =>
          s.write(person(members.owner), {
            projectId: members.projectId,
            name: "plan.md",
            bytes: text("# One"),
          }),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        await files((s) =>
          s.write(person(members.owner), {
            projectId: members.projectId,
            fileId: file.id,
            name: "plan.md",
            bytes: text("# Two"),
            basedOnVersion: 1,
          }),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        const versions = await files((s) => s.versions(members.owner, file.id));
        const firstVersion = versions.find((version) => version.number === 1)!.id;
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        seen[role] = await run(
          Effect.match(change(actor, { fileId: file.id, firstVersion }), {
            onSuccess: () => "ok",
            onFailure: (error) => error._tag,
          }),
        );
      }
      expect(seen).toEqual({
        owner: "ok",
        editor: "ok",
        viewer: "ProjectRejected",
        stranger: "ProjectNotAvailable",
      });
    },
  );

  it("keeps a file's name across its versions, never renaming it or clashing", async () => {
    const { owner, projectId } = await setup();
    const plan = await files((s) =>
      s.write(person(owner), { projectId, name: "plan.md", bytes: text("# One") }),
    );
    await files((s) => s.write(person(owner), { projectId, name: "notes.md", bytes: text("x") }));
    for (const renamed of ["notes.md", "renamed.md"])
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each must leave the file as it was.
      await expect(
        files((s) =>
          s.write(person(owner), {
            projectId,
            fileId: plan.id,
            name: renamed,
            bytes: text("# Two"),
            basedOnVersion: 1,
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ProjectRejected" });
    const listed = await files((s) => s.list(owner, projectId));
    expect(JSON.stringify(listed)).toContain("plan.md");
    expect((await files((s) => s.versions(owner, plan.id))).length).toBe(1);
  });

  it("refuses a write based on an older version or a duplicate name, and keeps any type", async () => {
    const { owner, editor, projectId } = await setup();
    const file = await files((s) =>
      s.write(person(owner), { projectId, name: "a.txt", bytes: text("one") }),
    );
    await files((s) =>
      s.write(person(editor), {
        projectId,
        fileId: file.id,
        name: "a.txt",
        bytes: text("two"),
        basedOnVersion: 1,
      }),
    );
    await expect(
      files((s) =>
        s.write(person(owner), {
          projectId,
          fileId: file.id,
          name: "a.txt",
          bytes: text("three"),
          basedOnVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ reason: expect.stringContaining("changed since version 1") });
    await expect(
      files((s) => s.write(person(owner), { projectId, name: "a.txt", bytes: text("again") })),
    ).rejects.toMatchObject({ reason: expect.stringContaining("already has a file named") });
    // A binary nobody can read is still kept, served as a download, and a
    // read explains that only a tool can use it.
    const binary = await files((s) =>
      s.write(person(owner), {
        projectId,
        name: "tool.exe",
        bytes: new Uint8Array([0x4d, 0x5a, 0x90]),
      }),
    );
    expect(binary.mediaType).toBe("application/octet-stream");
    const read = await files((s) => s.read(owner, projectId, { name: "tool.exe" }));
    expect(read).toMatchObject({
      content: null,
      note: expect.stringContaining("a tool that takes files"),
    });
  });

  it("advances same-user tokens and keeps published IDs immutable across saves and restores", async () => {
    const { owner, projectId } = await setup();
    const file = await files((s) =>
      s.write(person(owner), { projectId, name: "deck.txt", bytes: text("draft one") }),
    );
    const [draft] = await versionRows(file.id);
    const again = await files((s) =>
      s.write(person(owner), {
        projectId,
        fileId: file.id,
        name: "deck.txt",
        bytes: text("draft two"),
        basedOnVersion: 1,
      }),
    );
    expect(again.version).toBe(2);
    expect(await versionRows(file.id)).toHaveLength(2);
    expect((await files((s) => s.download(owner, draft!.id)))!.bytes).toEqual(text("draft one"));
    await expect(
      files((s) =>
        s.write(person(owner), {
          projectId,
          fileId: file.id,
          name: "deck.txt",
          bytes: text("stale tab"),
          basedOnVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProjectRejected" });
    const restored = await files((s) => s.restore(owner, draft!.id, 2));
    expect(restored.version).toBe(3);
    await expect(files((s) => s.restore(owner, draft!.id, 2))).rejects.toMatchObject({
      _tag: "ProjectRejected",
    });
    expect((await files((s) => s.download(owner, again.versionId)))!.bytes).toEqual(
      text("draft two"),
    );
    const model: FileWriter = {
      origin: "model",
      userId: owner,
      generationId: uuidv7(),
      guard: () => Effect.void,
    };
    const byModel = await files((s) =>
      s.write(model, { projectId, fileId: file.id, name: "deck.txt", bytes: text("model draft") }),
    );
    expect(byModel.version).toBe(4);
    const nextModel = await files((s) =>
      s.write(model, {
        projectId,
        fileId: file.id,
        name: "deck.txt",
        bytes: text("another model draft"),
        basedOnVersion: 4,
      }),
    );
    expect(nextModel.version).toBe(5);
    await expect(
      files((s) =>
        s.write(model, {
          projectId,
          fileId: file.id,
          name: "deck.txt",
          bytes: text("stale model draft"),
          basedOnVersion: 4,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProjectRejected" });
    expect((await files((s) => s.download(owner, byModel.versionId)))!.bytes).toEqual(
      text("model draft"),
    );
  });

  it("writes nothing for a model whose answer no longer owns the chat", async () => {
    const { owner, projectId } = await setup();
    const before = puts.length;
    const intentsBefore = await db((d) => d.select().from(blobCleanupIntents));
    const stale: FileWriter = {
      origin: "model",
      userId: owner,
      generationId: uuidv7(),
      guard: () => Effect.interrupt,
    };
    await expect(
      files((s) => s.write(stale, { projectId, name: "stopped.txt", bytes: text("late") })),
    ).rejects.toThrow("All fibers interrupted without error");
    expect((await files((s) => s.list(owner, projectId))).files).toEqual([]);
    expect(puts.length).toBe(before);
    expect(await db((d) => d.select().from(blobCleanupIntents))).toEqual(intentsBefore);
  });

  it("rejects unauthorized writers before storing but retains candidates for revocation during I/O", async () => {
    const { owner, editor, viewer, projectId } = await setup();
    const stranger = await createUser();
    const before = puts.length;
    for (const [writerId, refusal] of [
      [viewer, { _tag: "ProjectRejected", reason: "project files are read-only for you" }],
      [stranger, { _tag: "ProjectNotAvailable", projectId }],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each denial must precede physical storage.
      await expect(
        files((s) =>
          s.write(person(writerId), {
            projectId,
            name: "denied.txt",
            bytes: text("denied"),
          }),
        ),
      ).rejects.toMatchObject(refusal);
    }
    expect(puts.length).toBe(before);
    beforePut = () =>
      run(
        Effect.flatMap(ProjectService, (s) =>
          s.changeMembers(owner, projectId, { action: "removeUser", userId: editor }),
        ),
      );
    try {
      await expect(
        files((s) =>
          s.write(person(editor), {
            projectId,
            name: "revoked.txt",
            bytes: text(`revoked ${uuidv7()}`),
          }),
        ),
      ).rejects.toMatchObject({ _tag: "ProjectNotAvailable" });
    } finally {
      beforePut = undefined;
    }
    expect(puts.length).toBe(before + 1);
    const key = puts.at(-1)!;
    expect(
      await db((d) =>
        d.select().from(blobCleanupIntents).where(eq(blobCleanupIntents.storageKey, key)),
      ),
    ).toMatchObject([{ kind: "candidate" }]);
    expect(await run(Effect.flatMap(BlobStore, (s) => s.exists(key)))).toBe(true);
    expect((await files((s) => s.list(owner, projectId))).files).toEqual([]);
  });

  it("keeps the current version, pinned ones and recent history, and prunes the rest", async () => {
    const { owner, editor, projectId } = await setup();
    const file = await files((s) =>
      s.write(person(owner), { projectId, name: "log.txt", bytes: text("v1") }),
    );
    const [first] = await files((s) => s.versions(owner, file.id));
    await files((s) => s.pin(owner, first!.id, { pinned: true, label: "Original" }));
    // Alternating writers, so nothing collapses.
    for (let index = 2; index <= 30; index++)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each version builds on the last.
      await files((s) =>
        s.write(person(index % 2 ? owner : editor), {
          projectId,
          fileId: file.id,
          name: "log.txt",
          bytes: text(`v${index}`),
        }),
      );
    const kept = await versionRows(file.id);
    expect(kept.at(-1)!.number).toBe(30);
    expect(kept.find((row) => row.number === 1)).toMatchObject({ pinned: true, label: "Original" });
    expect(kept.filter((row) => !row.pinned)).toHaveLength(PROJECT_FILE_LIMITS.historyVersions);
    // Age alone also prunes: everything but the current and the pinned goes.
    await db((d) =>
      d
        .update(projectFileVersions)
        .set({ createdAt: sql`now() - interval '40 days'` })
        .where(eq(projectFileVersions.fileId, file.id)),
    );
    await files((s) =>
      s.write(person(owner), { projectId, fileId: file.id, name: "log.txt", bytes: text("v31") }),
    );
    expect((await versionRows(file.id)).map((row) => row.number)).toEqual([1, 31]);
  });

  it("drops the oldest history to stay under the cap, and refuses what cannot fit", async () => {
    const { owner, editor, projectId } = await setup();
    await files((s) => s.updateSettings(3_000));
    try {
      const file = await files((s) =>
        s.write(person(owner), { projectId, name: "big.txt", bytes: text("a".repeat(1_000)) }),
      );
      await files((s) =>
        s.write(person(editor), {
          projectId,
          fileId: file.id,
          name: "big.txt",
          bytes: text("b".repeat(1_000)),
        }),
      );
      await files((s) =>
        s.write(person(owner), {
          projectId,
          fileId: file.id,
          name: "big.txt",
          bytes: text("c".repeat(1_500)),
        }),
      );
      expect((await versionRows(file.id)).map((row) => row.number)).toEqual([2, 3]);
      await expect(
        files((s) =>
          s.write(person(owner), { projectId, name: "huge.txt", bytes: text("d".repeat(2_000)) }),
        ),
      ).rejects.toMatchObject({ reason: expect.stringContaining("storage is full") });
    } finally {
      await files((s) => s.updateSettings(PROJECT_FILE_LIMITS.defaultProjectBytes));
    }
  });

  it("takes account foreign-key locks before an editor waits on the project", async () => {
    const { owner, editor, projectId } = await setup();
    const held = await heldRow("projects", projectId);
    const account = new Client({ connectionString: database.url });
    await account.connect();
    await account.query("begin");
    const writing = Promise.allSettled([
      files((s) =>
        s.write(person(editor), { projectId, name: "editor.txt", bytes: text("editor") }),
      ),
    ]);
    let locking: Promise<unknown> | undefined;
    try {
      await held.wait(1);
      locking = account.query('select id from "user" where id = $1 for update', [owner]);
      await held.wait(2);
    } finally {
      await held.release();
      await locking;
      await account.query("rollback");
      await account.end();
      await writing;
    }
    expect(await writing).toMatchObject([{ status: "fulfilled" }]);
  });

  it("orders incoming dedup and pruned blob locks across projects", async () => {
    const owner = await createUser();
    const entries = [];
    for (const content of ["a", "b"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Seed two separate projects with one blob each.
      const project = await run(
        Effect.flatMap(ProjectService, (s) => s.create(owner, { name: content })),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- The published version supplies its real blob identity.
      const file = await files((s) =>
        s.write(person(owner), { projectId: project.id, name: "data.txt", bytes: text(content) }),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each write must finish before its immutable version is read.
      const [version] = await versionRows(file.id);
      entries.push({ projectId: project.id, fileId: file.id, blobId: version!.blobId, content });
      // Keep both blobs independently owned: this probes lock ordering, not byte deletion.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two normal uploads retain the seeded blobs.
      await run(
        Effect.flatMap(AttachmentService, (s) =>
          s.upload({
            userId: owner,
            fileName: `${content}.txt`,
            declaredMediaType: "text/plain",
            bytes: text(content),
          }),
        ),
      );
    }
    const [lower, higher] = entries.toSorted((a, b) => a.blobId.localeCompare(b.blobId));
    await files((s) => s.updateSettings(1));
    try {
      const held = await heldRow("attachment_blobs", lower!.blobId);
      const first = Promise.allSettled([
        files((s) =>
          s.write(person(owner), {
            projectId: higher!.projectId,
            fileId: higher!.fileId,
            name: "data.txt",
            bytes: text(lower!.content),
            basedOnVersion: 1,
          }),
        ),
      ]);
      let second: typeof first | undefined;
      try {
        await held.wait(1);
        second = Promise.allSettled([
          files((s) =>
            s.write(person(owner), {
              projectId: lower!.projectId,
              fileId: lower!.fileId,
              name: "data.txt",
              bytes: text(higher!.content),
              basedOnVersion: 1,
            }),
          ),
        ]);
        await held.wait(2);
      } finally {
        await held.release();
        await first;
        await second;
      }
      expect(await first).toMatchObject([{ status: "fulfilled" }]);
      expect(await second).toMatchObject([{ status: "fulfilled" }]);
      expect(await files((s) => s.list(owner, lower!.projectId))).toMatchObject({ usedBytes: 1 });
      expect(await files((s) => s.list(owner, higher!.projectId))).toMatchObject({ usedBytes: 1 });
    } finally {
      await files((s) => s.updateSettings(PROJECT_FILE_LIMITS.defaultProjectBytes));
    }
  });

  it("serializes distinct writers at the project byte quota", async () => {
    const { owner, editor, projectId } = await setup();
    await files((s) => s.updateSettings(150));
    try {
      const held = await heldRow("projects", projectId);
      const pending = Promise.allSettled([
        files((s) =>
          s.write(person(owner), { projectId, name: "a.txt", bytes: text("a".repeat(100)) }),
        ),
        files((s) =>
          s.write(person(editor), { projectId, name: "b.txt", bytes: text("b".repeat(100)) }),
        ),
      ]);
      try {
        await held.wait(2);
      } finally {
        await held.release();
        await pending;
      }
      const results = await pending;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await files((s) => s.list(owner, projectId))).toMatchObject({ usedBytes: 100 });
    } finally {
      await files((s) => s.updateSettings(PROJECT_FILE_LIMITS.defaultProjectBytes));
    }
  });

  it("serializes distinct creates at the project file-count quota", async () => {
    const { owner, editor, projectId } = await setup();
    const first = await files((s) =>
      s.write(person(owner), { projectId, name: "seed.txt", bytes: text("seed") }),
    );
    const [version] = await versionRows(first.id);
    await db((d) =>
      d.transaction((tx) =>
        Effect.gen(function* () {
          const rows = Array.from(
            { length: PROJECT_FILE_LIMITS.filesPerProject - 2 },
            (_, index) => ({
              id: uuidv7(),
              projectId,
              name: `seed-${index}.txt`,
            }),
          );
          yield* tx.insert(projectFiles).values(rows);
          yield* tx.insert(projectFileVersions).values(
            rows.map((row) => ({
              id: uuidv7(),
              fileId: row.id,
              number: 1,
              blobId: version!.blobId,
              size: 4,
              mediaType: "text/plain",
              origin: "user" as const,
              createdByUserId: owner,
            })),
          );
        }),
      ),
    );
    const held = await heldRow("projects", projectId);
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      pending = Promise.allSettled([
        files((s) => s.write(person(owner), { projectId, name: "a.txt", bytes: text("unique a") })),
        files((s) =>
          s.write(person(editor), { projectId, name: "b.txt", bytes: text("unique b") }),
        ),
      ]);
      await held.wait(2);
    } finally {
      await held.release();
    }
    expect((await pending!).filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await files((s) => s.list(owner, projectId))).files).toHaveLength(
      PROJECT_FILE_LIMITS.filesPerProject,
    );
  });

  it("reads an Office file's text for the model", async () => {
    const { owner, viewer, projectId } = await setup();
    const deck = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "ppt/presentation.xml": strToU8("<p/>"),
      "ppt/slides/slide1.xml": strToU8("<a:p><a:r><a:t>Autumn launch</a:t></a:r></a:p>"),
    });
    await files((s) => s.write(person(owner), { projectId, name: "Launch.pptx", bytes: deck }));
    const read = await files((s) => s.read(viewer, projectId, { name: "Launch.pptx" }));
    expect(read.content).toBe("## Slide 1\nAutumn launch");
    expect(read.file.mediaType).toContain("presentationml");
  });

  it("keeps validated attachment types across durable reads, queue transfer and branching", async () => {
    const { owner, editor, projectId } = await setup();
    const bytes = text(`export ${uuidv7()}`);
    const opaque = await files((s) =>
      s.write(person(editor), { projectId, name: "export.bin", bytes }),
    );
    expect(opaque.mediaType).toBe("application/octet-stream");
    const uploaded = await run(
      Effect.flatMap(AttachmentService, (s) =>
        s.upload({
          userId: owner,
          fileName: "export.txt",
          declaredMediaType: "text/plain",
          allowedKinds: ["text"],
          bytes,
        }),
      ),
    );
    expect(uploaded).toMatchObject({ mediaType: "text/plain", kind: "text", size: bytes.length });
    const opened = await run(
      Effect.flatMap(AttachmentService, (s) =>
        s.open({ userId: owner, attachmentId: uploaded.id }),
      ),
    );
    expect(opened).toMatchObject({ mediaType: "text/plain", size: bytes.length });
    expect(await run(opened.bytes)).toEqual(bytes);
    const repo = await run(AttachmentRepo);
    expect(await run(repo.listWithBlobsByIds(owner, [uploaded.id]))).toMatchObject([
      { id: uploaded.id, mediaType: "text/plain", size: bytes.length },
    ]);
    const chatId = uuidv7(),
      branchId = uuidv7(),
      queueId = uuidv7();
    const messageId = uuidv7(),
      copiedMessageId = uuidv7();
    await db((d) =>
      d.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(conversations).values([
            { id: chatId, userId: owner },
            { id: branchId, userId: owner },
          ]);
          yield* tx.insert(conversationQueueEntries).values({
            id: queueId,
            conversationId: chatId,
            userId: owner,
            content: "read export",
            input: { modelId: "fixture", searchEnabled: false, researchEnabled: false },
          });
          yield* repo.reconcileQueueEntry(tx, {
            userId: owner,
            queueEntryId: queueId,
            attachmentIds: [uploaded.id],
          });
        }),
      ),
    );
    expect(await run(repo.listForQueueEntries([queueId]))).toMatchObject([
      { id: uploaded.id, mediaType: "text/plain", kind: "text", size: bytes.length },
    ]);
    const cloned = await db((d) =>
      d.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(messages).values([
            { id: messageId, conversationId: chatId, role: "user", content: "read export" },
            { id: copiedMessageId, conversationId: branchId, role: "user", content: "read export" },
          ]);
          yield* repo.transferQueueEntry(tx, { queueEntryId: queueId, messageId });
          return yield* repo.cloneForMessages(tx, {
            userId: owner,
            messages: [{ sourceMessageId: messageId, targetMessageId: copiedMessageId }],
          });
        }),
      ),
    );
    expect(await run(repo.listForQueueEntries([queueId]))).toEqual([]);
    expect(await run(repo.listForMessages([messageId]))).toMatchObject([
      { id: uploaded.id, mediaType: "text/plain", kind: "text" },
    ]);
    const copiedId = cloned.get(uploaded.id)!;
    expect(copiedId).not.toBe(uploaded.id);
    expect(await run(repo.listForMessages([copiedMessageId]))).toMatchObject([
      { id: copiedId, mediaType: "text/plain", kind: "text" },
    ]);
    expect(await run(repo.listForConversation(owner, branchId))).toMatchObject([
      { id: copiedId, mediaType: "text/plain", kind: "text" },
    ]);
    expect(await run(repo.listWithBlobsForMessages([copiedMessageId]))).toMatchObject([
      { id: copiedId, mediaType: "text/plain" },
    ]);
    expect(
      await run(
        Effect.flatMap(AttachmentService, (s) => s.open({ userId: owner, attachmentId: copiedId })),
      ),
    ).toMatchObject({ mediaType: "text/plain" });
    expect(
      await db((d) =>
        d
          .select({ type: attachmentBlobs.mediaType })
          .from(attachmentBlobs)
          .where(eq(attachmentBlobs.userId, owner)),
      ),
    ).toEqual([{ type: "application/octet-stream" }]);
    expect((await files((s) => s.download(owner, opaque.versionId)))!.mediaType).toBe(
      "application/octet-stream",
    );
  });

  it("saves a person's attachment, but a model only one from its own chat", async () => {
    const { owner, projectId } = await setup();
    const attachment = await run(
      Effect.flatMap(AttachmentService, (s) =>
        s.upload({
          userId: owner,
          fileName: "brief.txt",
          declaredMediaType: "text/plain",
          bytes: text("brief"),
        }),
      ),
    );
    const saved = await files((s) =>
      s.saveAttachment(person(owner), { projectId, attachment: { id: attachment.id } }),
    );
    expect(saved).toMatchObject({ name: "brief.txt", version: 1 });
    // Another attachment saved over it is a new version of brief.txt, whatever it was called.
    const draft = await run(
      Effect.flatMap(AttachmentService, (s) =>
        s.upload({
          userId: owner,
          fileName: "draft-2.txt",
          declaredMediaType: "text/plain",
          bytes: text("brief, again"),
        }),
      ),
    );
    expect(
      await files((s) =>
        s.saveAttachment(person(owner), {
          projectId,
          attachment: { id: draft.id },
          fileId: saved.id,
          basedOnVersion: 1,
        }),
      ),
    ).toMatchObject({ name: "brief.txt", version: 2 });
    const chat = uuidv7();
    await db((d) => d.insert(conversations).values({ id: chat, userId: owner }));
    await expect(
      files((s) =>
        s.saveAttachment(
          { origin: "model", userId: owner, generationId: uuidv7(), guard: () => Effect.void },
          { projectId, attachment: { id: attachment.id }, conversationId: chat, fileId: saved.id },
        ),
      ),
    ).rejects.toMatchObject({ reason: "that attachment is not available" });
  });

  it("hands every file's bytes to cleanup when the project is deleted", async () => {
    const { owner, projectId } = await setup();
    const file = await files((s) =>
      s.write(person(owner), {
        projectId,
        name: "only-here.txt",
        bytes: text(`unique ${uuidv7()}`),
      }),
    );
    const [version] = await versionRows(file.id);
    await run(Effect.flatMap(ProjectService, (s) => s.remove(owner, projectId)));
    expect(
      await db((d) => d.select().from(projectFiles).where(eq(projectFiles.id, file.id))),
    ).toEqual([]);
    const intents = await db((d) => d.select().from(blobCleanupIntents));
    expect(intents.length).toBeGreaterThan(0);
    void version;
  });

  it("retries deletion when a newly attached chat holds a conversation lock", async () => {
    const { owner, editor, projectId } = await setup();
    const held = await heldRow("projects", projectId, "share");
    const writer = new Client({ connectionString: database.url });
    await writer.connect();
    const deleting = run(Effect.flatMap(ProjectService, (s) => s.remove(owner, projectId)));
    let writing: Promise<unknown> | undefined;
    const chatId = uuidv7();
    try {
      await held.wait(1);
      await db((d) => d.insert(conversations).values({ id: chatId, userId: editor, projectId }));
      await writer.query("begin");
      await writer.query("select id from conversations where id = $1 for update", [chatId]);
      writing = writer.query("select id from projects where id = $1 for share", [projectId]);
    } finally {
      await held.release();
    }
    try {
      await writing;
      await writer.query("commit");
      await deleting;
      expect(
        await db((d) =>
          d
            .select({ projectId: conversations.projectId })
            .from(conversations)
            .where(eq(conversations.id, chatId)),
        ),
      ).toEqual([{ projectId: null }]);
      expect(await db((d) => d.select().from(projects).where(eq(projects.id, projectId)))).toEqual(
        [],
      );
    } finally {
      await writer.end();
    }
  });

  it("hands a tool only files from this chat or its project, by id or name", async () => {
    const { owner, editor, viewer, projectId } = await setup();
    const chat = uuidv7();
    const otherChat = uuidv7();
    await db((d) =>
      d.insert(conversations).values([
        { id: chat, userId: owner },
        { id: otherChat, userId: owner },
      ]),
    );
    const attach = async (conversationId: string, fileName: string, body: string) => {
      const attachment = await run(
        Effect.flatMap(AttachmentService, (s) =>
          s.upload({ userId: owner, fileName, declaredMediaType: "", bytes: text(body) }),
        ),
      );
      const messageId = uuidv7();
      await db((d) =>
        d.insert(messages).values({ id: messageId, conversationId, role: "user", content: "" }),
      );
      await db((d) =>
        d
          .insert(messageAttachments)
          .values({ messageId, attachmentId: attachment.id, position: 0 }),
      );
      return attachment;
    };
    const brief = await attach(chat, "brief.md", "# Brief");
    await attach(otherChat, "secret.md", "elsewhere");
    const deck = await files((s) =>
      s.write(person(owner), { projectId, name: "deck.bin", bytes: new Uint8Array([1, 2, 3]) }),
    );
    const toolFilesFor = (userId: string) =>
      run(
        Effect.gen(function* () {
          return makeToolFileResolver({
            db: yield* Db,
            store: yield* BlobStore,
            projectFiles: Option.some(yield* ProjectFileService),
            userId,
            conversationId: chat,
            projectId,
          });
        }),
      );
    const resolverFor = async (userId: string) => (await toolFilesFor(userId)).resolve;
    const resolve = await resolverFor(owner);
    const byName = await run(resolve("brief.md"));
    expect(byName).toMatchObject({
      name: "brief.md",
      source: { kind: "chat", attachmentId: brief.id },
    });
    expect(new TextDecoder().decode(byName.bytes)).toBe("# Brief");
    expect(await run(resolve(brief.id))).toMatchObject({ name: "brief.md" });
    expect(await run(resolve("deck.bin"))).toMatchObject({
      name: "deck.bin",
      mediaType: "application/octet-stream",
      source: { kind: "project", version: 1 },
    });
    // Another chat's file is not this answer's to hand over.
    await expect(run(resolve("secret.md"))).rejects.toThrow(
      'No file "secret.md" in this chat or its project.',
    );
    // A member reading the project cannot reach the owner's chat files through it.
    const asViewer = await resolverFor(viewer);
    await expect(run(asViewer("brief.md"))).rejects.toThrow("No file");
    expect(await run(asViewer("deck.bin"))).toMatchObject({ source: { kind: "project" } });

    // A draft opened from version 1 stays publishable after version 2 lands:
    // publication asks only whether that version is still readable.
    const pinned = `project:${deck.id}@1`;
    // Another member's save, so it is not folded into the owner's own version.
    const second = await files((s) =>
      s.write(person(editor), {
        projectId,
        fileId: deck.id,
        name: "deck.bin",
        bytes: new Uint8Array([4, 5, 6]),
        basedOnVersion: 1,
      }),
    );
    expect(second.version).toBe(2);
    const ownerFiles = await toolFilesFor(owner);
    await expect(run(ownerFiles.resolve(pinned))).rejects.toThrow("changed since");
    expect(await run(ownerFiles.authorize(pinned))).toBe(true);
    expect(await run(ownerFiles.authorize(`attachment:${brief.id}`))).toBe(true);
    expect(await run(ownerFiles.authorize(`project:${deck.id}@3`))).toBe(false);
    const viewerFiles = await toolFilesFor(viewer);
    expect(await run(viewerFiles.authorize(pinned))).toBe(true);
    expect(await run(viewerFiles.authorize(`attachment:${brief.id}`))).toBe(false);
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, projectId, { action: "removeUser", userId: viewer }),
      ),
    );
    expect(await run(viewerFiles.authorize(pinned))).toBe(false);
  });
});
