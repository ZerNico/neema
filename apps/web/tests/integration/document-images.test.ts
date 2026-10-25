import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream, Duration } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attachmentBlobs, attachments, documentImages, user } from "~/db/schema/index.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { IMAGE_REFUSED } from "~/modules/documents/schema.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { english, type Localized } from "~/i18n/localized.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { Route } from "~/routes/api/documents/$documentId.images.$attachmentId.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: async (headers: Headers) => {
    const id = headers.get("x-test-user");
    return id ? { approved: true, session: { user: { id } } } : null;
  },
}));
vi.mock("~/server/runtime.ts", () => ({
  runtime: { runPromise: (effect: Effect.Effect<unknown>) => runtime.runPromise(effect) },
}));

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "document-images-it-"));

type Services =
  | Db
  | BlobStore
  | AttachmentRepo
  | AttachmentService
  | DocumentService
  | ProjectService
  | FeaturePolicy;
let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const core = Layer.mergeAll(DocumentRepo.layer, AttachmentRepo.layer, bus, fsBlobStoreLayer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(DocumentService.layer, ProjectService.layer, AttachmentService.layer).pipe(
      Layer.provideMerge(core),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const png = (seed: number) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);

const createUser = async () => {
  const id = uuidv7();
  await run(
    Effect.flatMap(Db, (db) => db.insert(user).values({ id, name: "Member", email: `${id}@t.io` })),
  );
  await run(seedEligibleSession(id));
  return id;
};
const upload = (userId: string, bytes: Uint8Array, fileName = "photo.png") =>
  run(
    Effect.flatMap(AttachmentService, (service) =>
      service.upload({ userId, fileName, declaredMediaType: "image/png", bytes }),
    ),
  );
const addImage = (userId: string, documentId: string, attachmentId: string) =>
  runtime.runPromiseExit(
    Effect.flatMap(DocumentService, (service) =>
      service.addImage(userId, { documentId, attachmentId }),
    ),
  );
const refusal = (result: Exit.Exit<string, unknown>) => {
  if (Exit.isSuccess(result)) return "claimed";
  const error = Cause.squash(result.cause);
  return error instanceof Error && "_tag" in error ? String(error._tag) : String(error);
};
const reason = (result: Exit.Exit<string, unknown>) => {
  if (Exit.isSuccess(result)) return undefined;
  const { reason: why } = Cause.squash(result.cause) as { reason?: Localized | string };
  return typeof why === "function" ? english(why) : why;
};

/** A project with an owner, an editor and a viewer, and one blank document in it. */
const projectDocument = async () => {
  const owner = await createUser();
  const editor = await createUser();
  const viewer = await createUser();
  const project = await run(
    Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Launch", instructions: "" })),
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
  const { document } = await run(
    Effect.flatMap(DocumentService, (s) =>
      s.create(owner, { projectId: project.id, title: "Plan", content: "", by: "user" }),
    ),
  );
  return { owner, editor, viewer, projectId: project.id, documentId: document.id };
};

const fetchImage = (documentId: string, attachmentId: string, userId?: string) => {
  const request = new Request(
    `http://localhost/api/documents/${documentId}/images/${attachmentId}`,
    { headers: userId ? { "x-test-user": userId } : {} },
  );
  const handlers = Route.options.server!.handlers!;
  if (typeof handlers === "function") throw new Error("Expected static route handlers");
  return Promise.resolve(
    handlers.GET!({ request, params: { documentId, attachmentId } } as never),
  ).then((result) => {
    if (!(result instanceof Response)) throw new Error("Expected a response");
    return result;
  });
};

/** The attachment a successful claim answered with, read back from its address. */
const claimedId = (result: Exit.Exit<string, unknown>) => {
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  return decodeURIComponent(result.value.split("/").at(-1) ?? "");
};
const attachmentRow = (attachmentId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db
        .select({ userId: attachments.userId, storageKey: attachmentBlobs.storageKey })
        .from(attachments)
        .innerJoin(attachmentBlobs, eq(attachmentBlobs.id, attachments.blobId))
        .where(eq(attachments.id, attachmentId)),
    ),
  ).then((rows) => rows[0] ?? null);
const storedBytes = (storageKey: string) =>
  run(Effect.flatMap(BlobStore, (store) => store.exists(storageKey)));
/** A cutoff in the future makes every unclaimed upload due. */
const sweep = () =>
  run(
    Effect.gen(function* () {
      const keys = yield* AttachmentRepo.use((repo) => repo.sweepUnclaimed(Duration.zero));
      yield* AttachmentService.use((service) => service.deleteBlobs(keys));
      return keys;
    }),
  );

const claimOf = (attachmentId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db.select().from(documentImages).where(eq(documentImages.attachmentId, attachmentId)),
    ),
  );

describe("claiming a document image", () => {
  it("claims the owner's own upload as it is and answers with its address", async () => {
    const { owner, documentId } = await projectDocument();
    const image = await upload(owner, png(11));
    const result = await addImage(owner, documentId, image.id);
    expect(result).toStrictEqual(Exit.succeed(`/api/documents/${documentId}/images/${image.id}`));
    expect(await claimOf(image.id)).toHaveLength(1);
    expect((await attachmentRow(image.id))?.userId).toBe(owner);
    // Claimed once: neither this document nor another may take it again.
    expect(reason(await addImage(owner, documentId, image.id))).toBe(english(IMAGE_REFUSED));
  });

  it("claims an editor's upload as the project owner's copy and spends the original", async () => {
    const { owner, editor, documentId } = await projectDocument();
    const image = await upload(editor, png(1));
    const original = await attachmentRow(image.id);
    const result = await addImage(editor, documentId, image.id);
    const claimed = claimedId(result);
    expect(claimed).not.toBe(image.id);
    expect(result).toStrictEqual(Exit.succeed(`/api/documents/${documentId}/images/${claimed}`));
    expect(await claimOf(claimed)).toHaveLength(1);
    const copy = await attachmentRow(claimed);
    expect(copy?.userId).toBe(owner);
    expect(await storedBytes(copy!.storageKey)).toBe(true);
    // The editor's upload is gone with its bytes, so it cannot be claimed again.
    expect(await attachmentRow(image.id)).toBeNull();
    expect(await storedBytes(original!.storageKey)).toBe(false);
    expect(reason(await addImage(editor, documentId, image.id))).toBe(english(IMAGE_REFUSED));
  });

  it("gives one upload to only one of two documents claiming it at once", async () => {
    const { owner, editor, projectId, documentId } = await projectDocument();
    const other = await run(
      Effect.flatMap(DocumentService, (s) =>
        s.create(owner, { projectId, title: "Other", content: "", by: "user" }),
      ),
    );
    const image = await upload(editor, png(12));
    const results = await Promise.all([
      addImage(editor, documentId, image.id),
      addImage(editor, other.document.id, image.id),
    ]);
    expect(results.map(refusal).toSorted()).toEqual(["DocumentRejected", "claimed"]);
    const held = claimedId(results.find(Exit.isSuccess)!);
    expect(await claimOf(held)).toHaveLength(1);
    // Each copies before its transaction, unless the other's claim already committed. A
    // refused one's copy is the sweep's.
    const ownersFiles = () =>
      run(
        Effect.flatMap(Db, (db) =>
          db.select({ id: attachments.id }).from(attachments).where(eq(attachments.userId, owner)),
        ),
      ).then((rows) => rows.map((row) => row.id));
    const copied = await ownersFiles();
    expect(copied).toContain(held);
    expect(copied.length).toBeLessThanOrEqual(2);
    await sweep();
    expect(await ownersFiles()).toEqual([held]);
    const winner = Exit.isSuccess(results[0]!) ? documentId : other.document.id;
    expect((await fetchImage(winner, held, owner)).status).toBe(200);
  });

  it("serves a claimed image only through its document, not to its uploader directly", async () => {
    const { owner, editor, documentId } = await projectDocument();
    const upload1 = await upload(editor, png(7));
    const before = await runtime.runPromiseExit(
      Effect.flatMap(AttachmentService, (s) =>
        s.read({ userId: editor, attachmentId: upload1.id }),
      ),
    );
    expect(Exit.isSuccess(before)).toBe(true);
    const claimed = await addImage(editor, documentId, upload1.id);
    expect(refusal(claimed)).toBe("claimed");
    // Nor to the owner whose copy it is.
    const owners = await runtime.runPromiseExit(
      Effect.flatMap(AttachmentService, (s) =>
        s.read({ userId: owner, attachmentId: claimedId(claimed) }),
      ),
    );
    expect(Exit.isFailure(owners) && Cause.squash(owners.cause)).toMatchObject({
      _tag: "AttachmentNotAvailable",
      attachmentId: claimedId(claimed),
    });
    // The plain file route caches for good and outlives project access, so it refuses.
    const after = await runtime.runPromiseExit(
      Effect.flatMap(AttachmentService, (s) =>
        s.read({ userId: editor, attachmentId: upload1.id }),
      ),
    );
    expect(Exit.isFailure(after) && Cause.squash(after.cause)).toMatchObject({
      _tag: "AttachmentNotAvailable",
      attachmentId: upload1.id,
    });
  });

  it("refuses someone else's upload, a viewer, a stranger and a non-image alike", async () => {
    const { owner, editor, viewer, documentId } = await projectDocument();
    const stranger = await createUser();

    const ownersImage = await upload(owner, png(2));
    expect(reason(await addImage(editor, documentId, ownersImage.id))).toBe(english(IMAGE_REFUSED));
    // An unknown id gets the very same answer, so the refusal reveals nothing.
    expect(reason(await addImage(editor, documentId, uuidv7()))).toBe(english(IMAGE_REFUSED));

    const viewersImage = await upload(viewer, png(3));
    expect(reason(await addImage(viewer, documentId, viewersImage.id))).toBe(
      "this document is read-only for you",
    );

    const strangersImage = await upload(stranger, png(4));
    expect(refusal(await addImage(stranger, documentId, strangersImage.id))).toBe(
      "DocumentNotAvailable",
    );

    const text = await run(
      Effect.flatMap(AttachmentService, (service) =>
        service.upload({
          userId: editor,
          fileName: "notes.txt",
          declaredMediaType: "text/plain",
          bytes: new TextEncoder().encode("not a picture"),
        }),
      ),
    );
    expect(reason(await addImage(editor, documentId, text.id))).toBe(english(IMAGE_REFUSED));

    for (const id of [ownersImage.id, viewersImage.id, strangersImage.id, text.id])
      // oxlint-disable-next-line eslint/no-await-in-loop -- A handful of reads.
      expect(await claimOf(id)).toHaveLength(0);
  });
});

describe("serving a document image", () => {
  it("serves a project member another member's image, uncached, and nobody outside", async () => {
    const { editor, viewer, owner, projectId, documentId } = await projectDocument();
    const bytes = png(5);
    const image = {
      id: claimedId(await addImage(editor, documentId, (await upload(editor, bytes)).id)),
    };

    const response = await fetchImage(documentId, image.id, viewer);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);

    const outsider = await createUser();
    expect((await fetchImage(documentId, image.id, outsider)).status).toBe(404);
    expect((await fetchImage(documentId, image.id)).status).toBe(401);

    // Only through the document that claimed it: another readable document does not serve it.
    const other = await run(
      Effect.flatMap(DocumentService, (s) =>
        s.create(owner, { projectId, title: "Other", content: "", by: "user" }),
      ),
    );
    expect((await fetchImage(other.document.id, image.id, viewer)).status).toBe(404);
    // An upload nothing claimed is not served through a document either.
    const loose = await upload(owner, png(6));
    expect((await fetchImage(documentId, loose.id, owner)).status).toBe(404);
  });
});

describe("the unclaimed sweep", () => {
  it("leaves a claimed image alone and takes it once its document is deleted", async () => {
    const { owner, documentId } = await projectDocument();
    const image = await upload(owner, png(7));
    await addImage(owner, documentId, image.id);

    await sweep();
    expect(await attachmentRow(image.id)).not.toBeNull();
    expect((await fetchImage(documentId, image.id, owner)).status).toBe(200);

    await run(Effect.flatMap(DocumentService, (s) => s.remove(owner, documentId)));
    expect(await claimOf(image.id)).toHaveLength(0);
    expect((await sweep()).length).toBeGreaterThan(0);
    expect(await attachmentRow(image.id)).toBeNull();
  });
});

describe("a member who deletes their account", () => {
  it("leaves the images they added to the project's documents in place", async () => {
    const { owner, editor, viewer, documentId } = await projectDocument();
    const bytes = png(21);
    const image = await upload(editor, bytes);
    const claimed = claimedId(await addImage(editor, documentId, image.id));

    // As account deletion does: the row goes, its rows cascade, then the person's files go.
    await run(Effect.flatMap(Db, (db) => db.delete(user).where(eq(user.id, editor))));
    await run(Effect.flatMap(AttachmentService, (s) => s.purgeUserFiles(editor)));
    await sweep();

    expect(await claimOf(claimed)).toHaveLength(1);
    for (const reader of [owner, viewer]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two readers, in order.
      const response = await fetchImage(documentId, claimed, reader);
      expect(response.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- The same response's body.
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(bytes);
    }
  });
});
