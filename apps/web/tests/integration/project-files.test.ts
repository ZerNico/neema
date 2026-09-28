import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Stream } from "effect";
import { strToU8, zipSync } from "fflate";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentBlobs,
  blobCleanupIntents,
  conversations,
  messageAttachments,
  messages,
  projectFileVersions,
  projectFiles,
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
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { FakeDocumentParser } from "./unused-services.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "project-files-it-"));

let database: TestDatabase;
type Services = Db | ProjectService | ProjectFileService | AttachmentService | BlobStore;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
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
    fsBlobStoreLayer,
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

  it("collapses a writer's quick saves into one version and frees the bytes it replaced", async () => {
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
      }),
    );
    expect(again.version).toBe(1);
    expect(await versionRows(file.id)).toHaveLength(1);
    // The first draft's bytes lost their last owner, so their blob row went with them.
    expect(
      await db((d) =>
        d.select().from(attachmentBlobs).where(eq(attachmentBlobs.id, draft!.blobId)),
      ),
    ).toEqual([]);
    // Another writer, or a pinned last version, keeps history.
    const model: FileWriter = {
      origin: "model",
      userId: owner,
      generationId: uuidv7(),
      guard: () => Effect.void,
    };
    const byModel = await files((s) =>
      s.write(model, { projectId, fileId: file.id, name: "deck.txt", bytes: text("model draft") }),
    );
    expect(byModel.version).toBe(2);
  });

  it("writes nothing for a model whose answer no longer owns the chat", async () => {
    const { owner, projectId } = await setup();
    const stale: FileWriter = {
      origin: "model",
      userId: owner,
      generationId: uuidv7(),
      guard: () => Effect.interrupt,
    };
    await expect(
      files((s) => s.write(stale, { projectId, name: "stopped.txt", bytes: text("late") })),
    ).rejects.toThrow();
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
