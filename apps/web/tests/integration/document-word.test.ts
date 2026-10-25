import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PgClient } from "@effect/sql-pg";
import { Transform } from "@tiptap/pm/transform";
import { images, openDocx, outline, title } from "@office-kit/docx";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Localized } from "~/i18n/localized.ts";
import type { Locale } from "~/paraglide/runtime.js";
import { attachments, documentImages, documents, limitSettings, user } from "~/db/schema/index.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { documentSchema, parseMarkdown, toMarkdown } from "~/modules/documents/editor/markdown.ts";
import { createFromWord } from "~/modules/documents/server/create-from-word.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { wordExportInput } from "~/modules/documents/server/word-export.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { documentToWord } from "~/modules/word/server/document-export.ts";
import { wordToDocument } from "~/modules/word/server/document-import.ts";
import { WordProcessor, type WordWork } from "~/modules/word/server/runtime.ts";
import { Db } from "~/server/db.ts";
import { Route as ExportRoute } from "~/routes/api/documents/$documentId.export.ts";
import { Route as ImageRoute } from "~/routes/api/documents/$documentId.images.$attachmentId.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";

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
  | ProjectService
  | FeaturePolicy
  | StorageQuota
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
      if (request.kind === "importDocument")
        return wordToDocument(request.bytes, request.bounds) as never;
      throw new Error(`Unexpected Word work: ${request.kind}`);
    },
    close: async () => {},
  });
  const core = Layer.mergeAll(DocumentRepo.layer, AttachmentRepo.layer, bus, fsBlobStoreLayer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(DocumentService.layer, ProjectService.layer, AttachmentService.layer, word).pipe(
      Layer.provideMerge(core),
    ),
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
  await run(seedEligibleSession(id));
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
const fetchImage = async (src: string, userId: string) => {
  const [, , , documentId, , attachmentId] = src.split("/");
  return handlers(ImageRoute).GET({
    request: new Request(`http://localhost${src}`, { headers: { "x-test-user": userId } }),
    params: { documentId: documentId!, attachmentId: attachmentId! },
  } as never);
};

const importWord = (
  userId: string,
  projectId: string,
  file: { name: string; bytes: Uint8Array },
  typed?: string,
) =>
  runtime.runPromiseExit(
    createFromWord(userId, {
      owner: { projectId },
      ...(typed ? { title: typed } : {}),
      by: "user",
      file: { ...file, mediaType: "" },
    }),
  );
const refusal = (exit: Exit.Exit<unknown, unknown>, locale: Locale = "en") => {
  if (!Exit.isFailure(exit)) return "created";
  const { reason } = Cause.squash(exit.cause) as { reason?: Localized | string };
  return typeof reason === "function" ? reason(locale) : reason;
};

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
  });
});

describe("starting a document from a Word file", () => {
  const wordFile = (markdown: string, threads = true) => {
    let commented = parseMarkdown(markdown);
    if (threads) {
      let from = -1;
      commented.descendants((node, position) => {
        if (from < 0 && node.isText && node.text?.startsWith("Ship")) from = position;
        return from < 0;
      });
      commented = new Transform(commented).addMark(
        from,
        from + "Ship it.".length,
        documentSchema.marks.comment!.create({ thread: "t1" }),
      ).doc;
    }
    return documentToWord(
      wordExportInput(
        "Imported plan",
        commented,
        threads
          ? [
              {
                id: "t1",
                threadId: "t1",
                author: { id: "x", name: "Grace" },
                byAssistant: false,
                fromFile: null,
                body: "Which Friday?",
                createdAt: "2026-10-01T09:00:00.000Z",
                resolvedAt: null,
                quote: null,
                toAssistant: false,
                answered: false,
              },
            ]
          : [],
        { "/api/documents/old/images/dot": PNG },
      ),
    );
  };

  it("keeps its text, claims its pictures for the document and brings its comments as file threads", async () => {
    const { owner, viewer, projectId } = await project();
    const bytes = wordFile(
      "# Goals\n\n- one\n- two\n\n![Dot](/api/documents/old/images/dot)\n\nShip it.",
    );
    const exit = await importWord(owner, projectId, { name: "Plan.docx", bytes });
    if (!Exit.isSuccess(exit)) throw Cause.squash(exit.cause);
    const { document, dropped } = exit.value;
    expect(dropped).toEqual([]);
    // The file's own title, since the person gave none.
    expect(document).toMatchObject({ title: "Imported plan", projectId, lastEditedBy: "user" });

    const read = await run(Effect.flatMap(DocumentService, (s) => s.read(viewer, document.id)));
    const markdown = toMarkdown(read!.doc);
    const src = /!\[Dot\]\(([^)]+)\)/.exec(markdown)?.[1] ?? "";
    expect(markdown).toBe(`# Goals\n\n- one\n- two\n\n![Dot](${src})\n\nShip it.`);
    expect(src).toMatch(new RegExp(`^/api/documents/${document.id}/images/`));
    // Served exactly as an uploaded image: to a reader, through this document.
    const image = await fetchImage(src, viewer);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    const claims = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(documentImages).where(eq(documentImages.documentId, document.id)),
      ),
    );
    expect(claims).toHaveLength(1);

    expect(read!.comments).toEqual([
      expect.objectContaining({
        fromFile: { name: "Grace" },
        author: null,
        body: "Which Friday?",
        quote: "Ship it.",
        resolvedAt: null,
      }),
    ]);
    // Its mark is on the text it was about.
    let marked = "";
    read!.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.attrs.thread === read!.comments[0]!.threadId))
        marked += node.text;
      return true;
    });
    expect(marked).toBe("Ship it.");

    // The exported file says what it is; a title typed in the dialog wins.
    const titled = await importWord(owner, projectId, { name: "Plan.docx", bytes }, "Mine");
    expect(Exit.isSuccess(titled) && titled.value.document.title).toBe("Mine");
  });

  it("fails an import whose pictures a person has no room for, saying so", async () => {
    const { owner, projectId } = await project();
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(limitSettings).set({ storageBytes: 1 }).where(eq(limitSettings.id, 1)),
      ),
    );
    try {
      const bytes = wordFile("See ![Dot](/api/documents/old/images/dot)\n\nShip it.", false);
      const exit = await importWord(owner, projectId, { name: "Plan.docx", bytes });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(refusal(exit)).toMatch(/Not enough storage/);
    } finally {
      await run(
        Effect.flatMap(Db, (db) =>
          db.update(limitSettings).set({ storageBytes: null }).where(eq(limitSettings.id, 1)),
        ),
      );
    }
  });

  it("stores a member's imported pictures as the project owner's, so they outlive the member", async () => {
    const { owner, viewer, projectId } = await project();
    const editor = await createUser("Editor");
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, projectId, {
          action: "addUser",
          email: `${editor}@t.io`,
          role: "editor",
        }),
      ),
    );
    const bytes = wordFile("See ![Dot](/api/documents/old/images/dot)\n\nShip it.", false);
    const exit = await importWord(editor, projectId, { name: "Plan.docx", bytes });
    if (!Exit.isSuccess(exit)) throw Cause.squash(exit.cause);
    const { document } = exit.value;
    const read = await run(Effect.flatMap(DocumentService, (s) => s.read(viewer, document.id)));
    const src = /!\[Dot\]\(([^)]+)\)/.exec(toMarkdown(read!.doc))?.[1] ?? "";
    const claims = await run(
      Effect.flatMap(Db, (db) =>
        db
          .select({ attachmentId: documentImages.attachmentId, userId: attachments.userId })
          .from(documentImages)
          .innerJoin(attachments, eq(attachments.id, documentImages.attachmentId))
          .where(eq(documentImages.documentId, document.id)),
      ),
    );
    // The tree points at the claimed copy, which is the owner's; the editor keeps no upload.
    expect(claims).toEqual([{ attachmentId: claims[0]?.attachmentId, userId: owner }]);
    expect(src).toBe(`/api/documents/${document.id}/images/${claims[0]!.attachmentId}`);
    const editorsFiles = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(attachments).where(eq(attachments.userId, editor)),
      ),
    );
    expect(editorsFiles).toEqual([]);

    // As account deletion does; the document's readers still get the picture.
    await run(Effect.flatMap(Db, (db) => db.delete(user).where(eq(user.id, editor))));
    await run(Effect.flatMap(AttachmentService, (s) => s.purgeUserFiles(editor)));
    for (const reader of [owner, viewer]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two readers, in order.
      const image = await fetchImage(src, reader);
      expect(image.status).toBe(200);
      // oxlint-disable-next-line eslint/no-await-in-loop -- The same response's body.
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    }
    const word = openDocx(
      new Uint8Array(await (await download(document.id, viewer)).arrayBuffer()),
    );
    expect(images(word).map((each) => each.data)).toEqual([PNG]);
  });

  it("refuses a file too large for a document, a broken one and an old one, storing nothing", async () => {
    const { owner, viewer, projectId } = await project();
    const count = async () =>
      (
        await run(
          Effect.flatMap(Db, (db) =>
            db.select().from(documents).where(eq(documents.projectId, projectId)),
          ),
        )
      ).length;
    const long = wordFile(
      Array.from({ length: 5_001 }, (_, index) => `Line ${index}`).join("\n\n"),
      false,
    );
    const tooLong = await importWord(owner, projectId, { name: "Long.docx", bytes: long });
    expect(refusal(tooLong)).toBe(
      "This Word file is too long for a document: it has 5,001 paragraphs, list items and tables, and a document holds 5,000.",
    );
    // The worker writes English; a German reader gets the same facts in German.
    expect(refusal(tooLong, "de")).toBe(
      "Diese Word-Datei ist zu lang für ein Dokument: Sie hat 5.001 Absätze, Listenpunkte und Tabellen, ein Dokument fasst 5.000.",
    );
    expect(
      refusal(
        await importWord(owner, projectId, {
          name: "Broken.docx",
          bytes: new TextEncoder().encode("PK not really a zip"),
        }),
      ),
    ).toBe("This is not a Word file the app can open.");
    expect(
      refusal(
        await importWord(owner, projectId, {
          name: "Old.doc",
          bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
        }),
      ),
    ).toBe("Old.doc is an older Word file; save it as .docx first.");
    // A viewer may not start documents in the project, from a file or otherwise.
    const small = wordFile("Ship it.", false);
    expect(refusal(await importWord(viewer, projectId, { name: "Small.docx", bytes: small }))).toBe(
      "this project is read-only for you",
    );
    expect(await count()).toBe(0);
  });
});
