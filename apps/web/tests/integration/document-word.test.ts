import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PgClient } from "@effect/sql-pg";
import { Transform } from "@tiptap/pm/transform";
import { images, openDocx, outline, title } from "@office-kit/docx";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "~/db/schema/index.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { documentSchema } from "~/modules/documents/editor/markdown.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { documentToWord } from "~/modules/word/server/document-export.ts";
import { WordProcessor, type WordWork } from "~/modules/word/server/runtime.ts";
import { Db } from "~/server/db.ts";
import { Route as ExportRoute } from "~/routes/api/documents/$documentId.export.ts";
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

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "document-word-it-"));

type Services =
  | Db
  | AttachmentRepo
  | AttachmentService
  | DocumentService
  | SheetService
  | ProjectService
  | FeaturePolicy
  | WordProcessor;
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
  // The real conversions, in process; the worker boundary is covered by the Word runtime test.
  const word = Layer.succeed(WordProcessor, {
    run: async (request: WordWork) => {
      if (request.kind === "exportDocument") return documentToWord(request.document) as never;
      throw new Error(`Unexpected Word work: ${request.kind}`);
    },
    close: async () => {},
  });
  const core = Layer.mergeAll(DocumentRepo.layer, AttachmentRepo.layer, bus, fsBlobStoreLayer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      DocumentService.layer,
      SheetService.layer,
      ProjectService.layer,
      AttachmentService.layer,
      word,
    ).pipe(Layer.provideMerge(core)),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

/** A real 2x2 PNG, so the export can size it and the import recognises it. */
const PNG = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    let c = 0xffffffff;
    for (const byte of out.subarray(4, 8 + data.length))
      c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
    return out;
  };
  const header = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 8, 0, 0, 0, 0]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 9, 9, 0, 9, 9])))),
    chunk("IEND", new Uint8Array()),
  ];
  return new Uint8Array(parts.flatMap((part) => [...part]));
})();

const createUser = async (name = "Member") => {
  const id = uuidv7();
  await run(Effect.flatMap(Db, (db) => db.insert(user).values({ id, name, email: `${id}@t.io` })));
  return id;
};

/** A project with an owner and a viewer. */
const project = async () => {
  const owner = await createUser("Owner");
  const viewer = await createUser("Viewer");
  const made = await run(
    Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Launch", instructions: "" })),
  );
  await run(
    Effect.flatMap(ProjectService, (s) =>
      s.changeMembers(owner, made.id, {
        action: "addUser",
        email: `${viewer}@t.io`,
        role: "viewer",
      }),
    ),
  );
  return { owner, viewer, projectId: made.id };
};

const handlers = <T extends { options: { server?: { handlers?: unknown } } }>(route: T) => {
  const found = route.options.server?.handlers;
  if (!found || typeof found === "function") throw new Error("Expected static route handlers");
  return found as { GET: (context: never) => Promise<Response> | Response };
};
const download = async (documentId: string, userId?: string) =>
  handlers(ExportRoute).GET({
    request: new Request(`http://localhost/api/documents/${documentId}/export`, {
      headers: userId ? { "x-test-user": userId } : {},
    }),
    params: { documentId },
  } as never);
describe("downloading a document as Word", () => {
  it("gives a reader the stored document, with its images, and nobody else anything", async () => {
    const { owner, viewer, projectId } = await project();
    const { document } = await run(
      Effect.flatMap(DocumentService, (s) =>
        s.create(owner, {
          projectId,
          title: "Plan: Q4/Q1",
          content: "# Goals\n\nShip **it**.^[By Friday.]",
          by: "user",
        }),
      ),
    );
    const picture = await run(
      Effect.flatMap(AttachmentService, (s) =>
        s.upload({
          userId: owner,
          fileName: "dot.png",
          declaredMediaType: "image/png",
          bytes: PNG,
        }),
      ),
    );
    const src = await run(
      Effect.flatMap(DocumentService, (s) =>
        s.addImage(owner, { documentId: document.id, attachmentId: picture.id }),
      ),
    );
    // A person's editor puts the claimed image into the text, as one step.
    await run(
      Effect.gen(function* () {
        const service = yield* DocumentService;
        const read = yield* service.read(owner, document.id);
        const image = documentSchema.nodes.image!.create({ src, alt: "Dot" });
        const step = new Transform(read!.doc).insert(
          read!.doc.content.size,
          documentSchema.nodes.paragraph!.create(null, image),
        ).steps[0]!;
        const pushed = yield* service.push(owner, {
          documentId: document.id,
          clientId: "editor",
          revision: read!.document.revision,
          steps: [JSON.stringify(step.toJSON())],
        });
        expect(pushed.conflict).toBe(false);
      }),
    );

    const response = await download(document.id, viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="document.docx"; filename*=UTF-8''${encodeURIComponent("Plan Q4 Q1.docx")}`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const word = openDocx(new Uint8Array(await response.arrayBuffer()));
    expect(title(word)).toBe("Plan: Q4/Q1");
    expect(outline(word).map((each) => each.text)).toEqual(["Goals"]);
    expect(images(word).map((each) => each.data)).toEqual([PNG]);

    const outsider = await createUser();
    expect((await download(document.id, outsider)).status).toBe(404);
    expect((await download(uuidv7(), owner)).status).toBe(404);
    expect((await download(document.id)).status).toBe(401);
    // A live sheet is downloaded as Excel, not here.
    const sheet = await run(
      Effect.flatMap(SheetService, (s) => s.create(owner, { projectId, title: "Budget" })),
    );
    expect((await download(sheet.id, owner)).status).toBe(404);
  });
});
