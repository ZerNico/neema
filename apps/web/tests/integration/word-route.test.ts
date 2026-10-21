import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { createWordFile, editWordFile, previewWordFile } from "~/modules/word/server/adapter.ts";
import { WordProcessor, type WordWork } from "~/modules/word/server/runtime.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { Route } from "~/routes/api/word/$kind.$fileId.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { FakeDocumentParser } from "./unused-services.ts";

vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: async (headers: Headers) => {
    const id = headers.get("x-test-user");
    return id
      ? { approved: headers.get("x-test-approved") !== "false", session: { user: { id } } }
      : null;
  },
}));
vi.mock("~/server/runtime.ts", () => ({
  runtime: { runPromise: (effect: Effect.Effect<unknown>) => runtime.runPromise(effect) },
}));

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "word-route-it-"));

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  Db | AttachmentService | ProjectFileService | ProjectService | WordProcessor,
  unknown
>;
let document: Uint8Array;
// The real preview, in process; the worker boundary is covered by the runtime tests.
const work = vi.fn(async (request: WordWork): Promise<unknown> => {
  if (request.kind !== "preview") throw new Error("Unexpected Word work");
  return previewWordFile(request.bytes);
});

beforeAll(async () => {
  database = await createTestDatabase();
  document = editWordFile(createWordFile(), [
    {
      kind: "insertParagraphs",
      at: "start",
      paragraphs: [{ text: "Plan", style: "heading1" }, { text: "Rent is **900**." }],
    },
  ]).bytes;
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const repos = Layer.mergeAll(
    AttachmentRepo.layer,
    bus,
    fsBlobStoreLayer,
    FakeDocumentParser,
  ).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  const attachments = AttachmentService.layer.pipe(Layer.provideMerge(repos));
  const processor = Layer.succeed(WordProcessor, {
    // The stub answers whichever job it is asked; the route only asks for previews.
    run: (request: WordWork) => work(request) as never,
    close: async () => {},
  });
  runtime = ManagedRuntime.make(
    Layer.mergeAll(ProjectFileService.layer, ProjectService.layer, processor).pipe(
      Layer.provideMerge(attachments),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const createUser = async () => {
  const id = uuidv7();
  await runtime.runPromise(
    Effect.flatMap(Db, (db) => db.insert(user).values({ id, name: "Member", email: `${id}@t.io` })),
  );
  return id;
};
const upload = (userId: string, fileName: string, bytes: Uint8Array) =>
  runtime.runPromise(
    Effect.flatMap(AttachmentService, (service) =>
      service.upload({ userId, fileName, declaredMediaType: "", bytes }),
    ),
  );
const get = (kind: string, fileId: string, userId?: string, approved = true) => {
  const url = new URL(`http://localhost/api/word/${kind}/${fileId}`);
  const request = new Request(url, {
    headers: userId ? { "x-test-user": userId, "x-test-approved": String(approved) } : {},
  });
  const handlers = Route.options.server!.handlers!;
  if (typeof handlers === "function") throw new Error("Expected static route handlers");
  return Promise.resolve(handlers.GET!({ request, params: { kind, fileId } } as never)).then(
    (result) => {
      if (!(result instanceof Response)) throw new Error("Expected a preview response");
      return result;
    },
  );
};

describe("Word preview route", () => {
  it("previews a document for someone who may read the file, and nobody else", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const attachment = await upload(owner, "plan.docx", document);
    expect(attachment.mediaType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect((await get("attachment", attachment.id)).status).toBe(401);
    expect((await get("attachment", attachment.id, owner, false)).status).toBe(401);
    expect((await get("upload", attachment.id, owner)).status).toBe(404);
    expect((await get("attachment", attachment.id, stranger)).status).toBe(404);
    expect(work).not.toHaveBeenCalled();

    const first = await get("attachment", attachment.id, owner);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await first.json()).toMatchObject({
      blocks: [
        { type: "paragraph", role: "heading", level: 1, runs: [{ text: "Plan" }] },
        {
          type: "paragraph",
          role: "body",
          runs: [{ text: "Rent is " }, { text: "900", bold: true }, { text: "." }],
        },
        // A new document's own empty paragraph.
        { type: "paragraph", role: "body", runs: [] },
      ],
    });
    expect(work).toHaveBeenCalledTimes(1);

    // The cached preview is served only after the request's own access check.
    expect((await get("attachment", attachment.id, stranger)).status).toBe(404);
    expect((await get("attachment", attachment.id, owner)).status).toBe(200);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but a Word document before any worker sees it", async () => {
    const owner = await createUser();
    work.mockClear();
    const text = await upload(owner, "notes.txt", new TextEncoder().encode("hello"));
    const response = await get("attachment", text.id, owner);
    expect(response.status).toBe(422);
    expect(work).not.toHaveBeenCalled();
  });
});
