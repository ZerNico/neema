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
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import {
  createSpreadsheet,
  editSpreadsheet,
  previewSpreadsheet,
} from "~/modules/spreadsheets/server/adapter.ts";
import {
  SpreadsheetProcessor,
  type SpreadsheetWork,
} from "~/modules/spreadsheets/server/runtime.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { Route } from "~/routes/api/spreadsheets/$kind.$fileId.ts";
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

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "spreadsheet-route-it-"));

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  Db | AttachmentService | ProjectFileService | ProjectService | SpreadsheetProcessor,
  unknown
>;
let workbook: Uint8Array;
// The real preview, in process; the worker boundary is covered by the runtime tests.
const work = vi.fn(async (request: SpreadsheetWork): Promise<unknown> => {
  if (request.kind !== "preview") throw new Error("Unexpected spreadsheet work");
  return previewSpreadsheet(request.bytes, request.sheet);
});

beforeAll(async () => {
  database = await createTestDatabase();
  workbook = (
    await editSpreadsheet(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Item", "Cost"],
          ["Rent", 900],
        ],
      },
      { kind: "addSheet", name: "Totals" },
      { kind: "setCells", sheet: "Totals", start: "A1", rows: [["=Sheet1!B2*12"]] },
    ])
  ).bytes;
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
  ).pipe(Layer.provideMerge(FeaturePolicy.layer), Layer.provideMerge(infrastructure));
  const attachments = AttachmentService.layer.pipe(Layer.provideMerge(repos));
  const processor = Layer.succeed(SpreadsheetProcessor, {
    // The stub answers whichever job it is asked; the route only asks for previews.
    run: (request: SpreadsheetWork) => work(request) as never,
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
const get = (kind: string, fileId: string, userId?: string, sheet?: string, approved = true) => {
  const url = new URL(`http://localhost/api/spreadsheets/${kind}/${fileId}`);
  if (sheet !== undefined) url.searchParams.set("sheet", sheet);
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

describe("spreadsheet preview route", () => {
  it("previews a sheet for someone who may read the file, and nobody else", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const attachment = await upload(owner, "budget.xlsx", workbook);
    expect((await get("attachment", attachment.id)).status).toBe(401);
    expect((await get("attachment", attachment.id, owner, undefined, false)).status).toBe(401);
    expect((await get("upload", attachment.id, owner)).status).toBe(404);
    expect((await get("attachment", attachment.id, stranger)).status).toBe(404);
    expect(work).not.toHaveBeenCalled();

    const first = await get("attachment", attachment.id, owner);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await first.json()).toMatchObject({
      sheet: "Sheet1",
      sheets: [{ name: "Sheet1" }, { name: "Totals" }],
      rows: [
        [{ text: "Item" }, { text: "Cost" }],
        [{ text: "Rent" }, { text: "900" }],
      ],
    });
    const totals = await get("attachment", attachment.id, owner, "Totals");
    expect(await totals.json()).toMatchObject({ sheet: "Totals", rows: [[{ text: "10800" }]] });
    expect(work).toHaveBeenCalledTimes(2);

    // The cached grid is served only after the request's own access check.
    expect((await get("attachment", attachment.id, stranger)).status).toBe(404);
    expect((await get("attachment", attachment.id, owner)).status).toBe(200);
    expect(work).toHaveBeenCalledTimes(2);
    expect((await get("attachment", attachment.id, owner, "Nope")).status).toBe(404);
  });

  it("refuses anything but a workbook before any worker sees it", async () => {
    const owner = await createUser();
    work.mockClear();
    const text = await upload(owner, "notes.txt", new TextEncoder().encode("hello"));
    const response = await get("attachment", text.id, owner);
    expect(response.status).toBe(422);
    expect(work).not.toHaveBeenCalled();
  });
});
