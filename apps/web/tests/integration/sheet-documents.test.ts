import { PgClient } from "@effect/sql-pg";
import { Effect, Fiber, Layer, ManagedRuntime, Option, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { conversations, user } from "~/db/schema/index.ts";
import type { SheetFrame } from "~/modules/documents/sheet/schema.ts";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

let database: TestDatabase;
type Services = Db | DocumentRepo | DocumentService | SheetService;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let appLayer: Layer.Layer<Services, unknown>;
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
  const core = Layer.mergeAll(DocumentRepo.layer, TestBus).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(infrastructure),
  );
  appLayer = Layer.mergeAll(DocumentService.layer, SheetService.layer).pipe(
    Layer.provideMerge(core),
  );
  runtime = ManagedRuntime.make(appLayer);
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const sheets = <A, E>(f: (service: SheetService["Service"]) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(SheetService, f));
const createSheet = async () => {
  const owner = uuidv7();
  const conversationId = uuidv7();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(user).values({ id: owner, name: "Sheet owner", email: `${owner}@t.io` });
      yield* db.insert(conversations).values({ id: conversationId, userId: owner });
    }),
  );
  const document = await sheets((s) =>
    s.create(owner, {
      conversationId,
      title: "Budget",
      locale: "de-DE",
      timeZone: "Europe/Berlin",
    }),
  );
  return { owner, document };
};
/** The cell at a row and column number, by the document's current positions. */
const at = (doc: SheetDoc, row: number, col: number) => ({
  r: positions(doc.sheet.s1!.rows).ids[row - 1]!,
  c: positions(doc.sheet.s1!.cols).ids[col - 1]!,
});
const setValue = (doc: SheetDoc, row: number, col: number, v: number | string): SheetOp => ({
  op: "set",
  sh: "s1",
  cells: [{ ...at(doc, row, col), v }],
});
/** A push as an editor sends it: each change as JSON text. */
const stringified = (input: { documentId: string; clientId: string; changes: unknown[] }) => ({
  ...input,
  changes: input.changes.map((change) => JSON.stringify(change)),
});
const readDoc = async (owner: string, documentId: string) =>
  (await sheets((s) => s.read(owner, documentId)))!;
const valueAt = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return doc.sheet.s1!.cells[r]?.[c]?.v;
};

describe("live sheets", () => {
  it("creates an empty sheet that the text service will not open", async () => {
    const { owner, document } = await createSheet();
    expect(document.kind).toBe("sheet");
    const read = await readDoc(owner, document.id);
    expect(read.doc.settings).toEqual({ locale: "de-DE", timeZone: "Europe/Berlin" });
    expect(read.revision).toBe(0);
    expect(
      await runtime.runPromise(Effect.flatMap(DocumentService, (s) => s.read(owner, document.id))),
    ).toBe(null);
  });

  it("applies each client's next change once, acknowledges resends and waits out a gap", async () => {
    const { owner, document } = await createSheet();
    const { doc } = await readDoc(owner, document.id);
    const change = (seq: number, value: number) => ({
      clientId: "a",
      seq,
      ops: [setValue(doc, seq, 1, value)],
    });
    const first = await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [change(1, 10), change(2, 20)],
        }),
      ),
    );
    expect(first).toEqual({ revision: 2, acked: 2, refused: [] });
    // 1 and 2 again are a resend; 4 without 3 would skip one, so only 3 applies.
    const second = await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [change(1, 99), change(2, 99), change(3, 30), change(5, 50)],
        }),
      ),
    );
    expect(second).toEqual({ revision: 3, acked: 3, refused: [] });
    const after = (await readDoc(owner, document.id)).doc;
    expect([1, 2, 3, 5].map((row) => valueAt(after, row, 1))).toEqual([10, 20, 30, undefined]);
  });

  it("refuses a change it cannot keep and moves on past it", async () => {
    const { owner, document } = await createSheet();
    const result = await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [{ clientId: "a", seq: 1, ops: [{ op: "settings", locale: "xx-XX" }] }],
        }),
      ),
    );
    expect(result).toEqual({
      revision: 0,
      acked: 1,
      refused: [{ seq: 1, reason: "no locale xx-XX" }],
    });
    await expect(
      sheets((s) =>
        s.push(
          owner,
          stringified({
            documentId: document.id,
            clientId: "a",
            changes: [{ clientId: "b", seq: 2, ops: [] }],
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it("sends every change to every editor with the moment it was made", async () => {
    const { owner, document } = await createSheet();
    const { doc } = await readDoc(owner, document.id);
    const feed = await sheets((s) =>
      s.subscribe(owner, document.id, { revision: 0, clientId: "b" }),
    );
    const received = Effect.runFork(feed!.pipe(Stream.take(3), Stream.runCollect));
    await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [{ clientId: "a", seq: 1, ops: [setValue(doc, 1, 1, 5)] }],
        }),
      ),
    );
    const frames = [...(await Effect.runPromise(Fiber.join(received)))] as SheetFrame[];
    expect(frames.map((frame) => frame.type)).toEqual(["changes", "comments", "changes"]);
    const last = frames[2]!;
    if (last.type !== "changes") throw new Error("expected changes");
    expect(last).toMatchObject({ revision: 1, changes: [{ clientId: "a", seq: 1 }] });
    // NOW on the sheet's clock: a Berlin date serial, today or so.
    expect(last.moment.now).toBeGreaterThan(45_000);
    expect(Number.isInteger(last.moment.seed)).toBe(true);
  });

  it("rebuilds from storage, telling a reset which of the client's changes are in", async () => {
    const { owner, document } = await createSheet();
    const { doc } = await readDoc(owner, document.id);
    await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [
            { clientId: "a", seq: 1, ops: [setValue(doc, 1, 1, 1)] },
            { clientId: "a", seq: 2, ops: [setValue(doc, 2, 1, 2)] },
          ],
        }),
      ),
    );
    const fresh = ManagedRuntime.make(appLayer);
    try {
      const feed = await fresh.runPromise(
        Effect.flatMap(SheetService, (s) =>
          s.subscribe(owner, document.id, { revision: null, clientId: "a" }),
        ),
      );
      const frame = Option.getOrThrow(await fresh.runPromise(Stream.runHead(feed!)));
      if (frame.type !== "reset") throw new Error("expected reset");
      expect(frame).toMatchObject({ revision: 2, acked: 2 });
      expect([valueAt(frame.doc, 1, 1), valueAt(frame.doc, 2, 1)]).toEqual([1, 2]);
      // A write through the other process leaves this one's entry behind; it rebuilds and applies.
      await fresh.runPromise(
        Effect.flatMap(SheetService, (s) =>
          s.push(
            owner,
            stringified({
              documentId: document.id,
              clientId: "b",
              changes: [{ clientId: "b", seq: 1, ops: [setValue(doc, 3, 1, 3)] }],
            }),
          ),
        ),
      );
    } finally {
      await fresh.dispose();
    }
    const pushed = await sheets((s) =>
      s.push(
        owner,
        stringified({
          documentId: document.id,
          clientId: "a",
          changes: [{ clientId: "a", seq: 3, ops: [setValue(doc, 4, 1, 4)] }],
        }),
      ),
    );
    expect(pushed).toEqual({ revision: 4, acked: 3, refused: [] });
    const after = (await readDoc(owner, document.id)).doc;
    expect([1, 2, 3, 4].map((row) => valueAt(after, row, 1))).toEqual([1, 2, 3, 4]);
  });

  it("numbers a server-made change in its client's own sequence", async () => {
    const { owner, document } = await createSheet();
    const write = (value: number) =>
      sheets((s) =>
        s.change(
          owner,
          { documentId: document.id, clientId: "model.g1", generationId: null },
          undefined,
          (doc) => Effect.succeed({ result: value, ops: [setValue(doc, 1, 1, value)] }),
        ),
      );
    expect(await write(1)).toMatchObject({ result: 1, refused: null, dropped: [] });
    await write(2);
    const feed = await sheets((s) =>
      s.subscribe(owner, document.id, { revision: 0, clientId: null }),
    );
    const frame = Option.getOrThrow(await Effect.runPromise(Stream.runHead(feed!)));
    expect(frame).toMatchObject({
      type: "changes",
      changes: [
        { clientId: "model.g1", seq: 1 },
        { clientId: "model.g1", seq: 2 },
      ],
    });
  });

  it("puts a thread on a cell, keeps its replies and lets the assistant start one", async () => {
    const { owner, document } = await createSheet();
    const thread = uuidv7();
    const cell = { sh: "s1", r: "s1.r2", c: "s1.c2" };
    await sheets((s) =>
      s.comment(owner, { documentId: document.id, threadId: thread, body: "Check this", cell }),
    );
    await sheets((s) =>
      s.comment(owner, { documentId: document.id, threadId: thread, body: "Still wrong" }),
    );
    // A new thread must name a cell that exists.
    await expect(
      sheets((s) =>
        s.comment(owner, { documentId: document.id, threadId: uuidv7(), body: "Where?" }),
      ),
    ).rejects.toThrow();
    const assistant = await sheets((s) =>
      s.assistantComment(
        owner,
        {
          documentId: document.id,
          cell: { sh: "s1", r: "s1.r1", c: "s1.c1" },
          body: "Totals here",
        },
        () => Effect.void,
      ),
    );
    expect(assistant).toMatchObject({ outcome: "commented" });
    await sheets((s) =>
      s.resolveThread(owner, { documentId: document.id, threadId: thread, resolved: true }),
    );
    const read = await readDoc(owner, document.id);
    expect(read.doc.anchors[thread]).toEqual(cell);
    expect(Object.keys(read.doc.anchors)).toHaveLength(2);
    expect(read.comments.filter((each) => each.threadId === thread)).toHaveLength(2);
    expect(read.comments.find((each) => each.id === thread)?.resolvedAt).not.toBeNull();
  });
});
