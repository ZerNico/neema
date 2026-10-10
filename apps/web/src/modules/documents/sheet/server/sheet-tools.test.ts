import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { DocumentComment, EditableDocument } from "../../schema.ts";
import { readCsv } from "./import.ts";
import {
  prepareDocumentTools,
  type DocumentToolService,
  type SheetToolService,
} from "../../server/document-tools.ts";

const stamp = new Date(0).toISOString();

/** Sheets in memory, changed through the real `applyChange`, as the sheet service does. */
function fakeSheets() {
  const rows = new Map<string, { document: EditableDocument; doc: SheetDoc }>();
  const seqs = new Map<string, number>();
  const comments: DocumentComment[] = [];
  let written: (() => void) | null = null;
  /** Resolves once the model's next change is in, for a preview written in the background. */
  const nextWrite = () =>
    new Promise<void>((resolve) => {
      written = resolve;
    });
  const commit = (documentId: string, clientId: string, ops: SheetOp[], by: "user" | "model") => {
    const row = rows.get(documentId)!;
    const revision = row.document.revision + 1;
    const seq = (seqs.get(clientId) ?? 0) + 1;
    seqs.set(clientId, seq);
    const applied = applyChange(row.doc, { clientId, seq, ops }, revision);
    const document = { ...row.document, revision, lastEditedBy: by };
    rows.set(documentId, { document, doc: applied.doc });
    return { document, dropped: applied.dropped };
  };
  const sheets: SheetToolService = {
    create: (_userId, input, _guard, from) =>
      Effect.sync(() => {
        const document: EditableDocument = {
          id: `sheet-${rows.size + 1}`,
          conversationId: input.conversationId ?? null,
          projectId: input.projectId ?? null,
          title: input.title,
          kind: "sheet",
          revision: 0,
          lastEditedBy: "model",
          canEdit: true,
          createdAt: stamp,
          updatedAt: stamp,
        };
        rows.set(document.id, {
          document,
          doc: from ?? emptyDoc("Sheet1", { locale: input.locale ?? "en-US", timeZone: "UTC" }),
        });
        return document;
      }),
    read: (_userId, documentId) =>
      Effect.sync(() => {
        const row = rows.get(documentId);
        return row
          ? {
              document: row.document,
              doc: row.doc,
              revision: row.document.revision,
              moment: { now: 45_000, seed: 1 },
              comments: [...comments],
            }
          : null;
      }),
    assistantComment: (_userId, input) =>
      Effect.sync(() => {
        const thread = input.thread ?? `t${comments.length + 1}`;
        comments.push({
          id: input.thread ? `c${comments.length + 1}` : thread,
          threadId: thread,
          author: null,
          byAssistant: true,
          fromFile: null,
          body: input.body,
          createdAt: stamp,
          resolvedAt: null,
          quote: input.quote ?? null,
          toAssistant: false,
          answered: false,
        });
        if (!input.thread && input.cell)
          commit(input.documentId, "a", [{ op: "anchor", thread, at: input.cell }], "model");
        return { outcome: "commented" as const, thread };
      }),
    change: (_userId, input, _guard, decide) =>
      Effect.gen(function* () {
        const row = rows.get(input.documentId)!;
        const decided = yield* decide(row.doc, row.document);
        if (!decided.ops?.length)
          return { result: decided.result, document: row.document, refused: null, dropped: [] };
        const committed = commit(input.documentId, input.clientId, [...decided.ops], "model");
        written?.();
        return { result: decided.result, ...committed, refused: null };
      }).pipe(Effect.orDie),
  };
  // Only these two are reached for a sheet; the text service's writes never are.
  const service: Pick<DocumentToolService, "list" | "read"> = {
    list: () => Effect.sync(() => [...rows.values()].map((row) => row.document)),
    read: () => Effect.succeed(null),
  };
  /** What a person's grid does: a change of their own. */
  const personWrites = (documentId: string, ops: SheetOp[]) =>
    commit(documentId, "person", ops, "user");
  return { sheets, service, rows, personWrites, nextWrite };
}

const prepare = (
  fake: ReturnType<typeof fakeSheets>,
  open?: { documentId: string; selected: string[] },
) =>
  Effect.runPromise(
    prepareDocumentTools({
      readSheetFile: (reference) =>
        reference === "attachment:costs"
          ? Effect.succeed({ name: "Costs.csv", read: readCsv("Item,Amount\nTea,4\n", "Costs") })
          : Effect.fail("No file with that reference."),
      service: fake.service as DocumentToolService,
      sheets: fake.sheets,
      ...(open ? { openDocumentId: open.documentId, selectedBlocks: open.selected } : {}),
      generationId: "g1",
      userId: "user",
      conversationId: "conv-1",
      messageId: "message-1",
      writeGuard: () => Effect.void,
      liveGuard: () => Effect.void,
    }),
  );
type Tools = Awaited<ReturnType<typeof prepare>>;
const call = (tools: Tools, name: string, params: unknown) =>
  Effect.runPromise(
    (
      tools.group.handlers as Record<
        string,
        (raw: unknown) => Effect.Effect<Record<string, unknown>>
      >
    )[name]!(params),
  );
/** The trailing context as one string, marked as sent like a real request. */
const send = (tools: Tools) => {
  const messages = tools.messages();
  tools.sent({ content: messages.map((message) => ({ content: String(message.content) })) });
  return messages.map((message) => String(message.content)).join("\n");
};

describe("live sheet tools", () => {
  it("creates a sheet, fills it and shows what its formulas calculate", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    const created = await call(tools, "create_sheet", {
      title: "Budget",
      operations: [
        {
          kind: "setCells",
          sheet: "Sheet1",
          start: "A1",
          rows: [
            ["Rent", 900],
            ["Food", 300],
          ],
        },
        { kind: "setCells", sheet: "Sheet1", start: "A3", rows: [["Total", "=SUM(B1:B2)"]] },
      ],
    });
    expect(created).toMatchObject({ outcome: "created", documentId: "sheet-1", revision: 1 });
    expect(send(tools)).toContain('3| A3 "Total" | B3 =SUM(B1:B2) → 1200');
  });

  it("refuses to overwrite a person's change it has not seen, then writes once it has", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", {
      title: "Plan",
      operations: [{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["draft"]] }],
    });
    send(tools);
    const { doc } = fake.rows.get("sheet-1")!;
    const r = doc.sheet.s1!.rows[0]!.id;
    const c = doc.sheet.s1!.cols[0]!.id;
    fake.personWrites("sheet-1", [{ op: "set", sh: "s1", cells: [{ r, c, v: "theirs" }] }]);
    const overwrite = {
      operations: [{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["mine"]] }],
    };
    expect(await call(tools, "edit_sheet", overwrite)).toMatchObject({ outcome: "conflict" });
    // Its own earlier write was never in the way: only the person's is.
    expect(send(tools)).toContain('1| A1 "theirs"');
    expect(await call(tools, "edit_sheet", overwrite)).toMatchObject({ outcome: "updated" });
  });

  it("points a text tool at a sheet to the sheet tool", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    expect(await call(tools, "edit_document", { target: "x", content: "y" })).toMatchObject({
      outcome: "invalid",
      message: "This is a live sheet; change it with edit_sheet.",
    });
  });

  it("moves the window to another range when asked", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", {
      title: "Long",
      operations: [
        {
          kind: "setCells",
          sheet: "Sheet1",
          start: "A1",
          rows: Array.from({ length: 30 }, (_, index) => [index + 1]),
        },
      ],
    });
    send(tools);
    await call(tools, "read_chat_document", { documentId: "sheet-1", range: "A20:A22" });
    const view = send(tools);
    expect(view).toContain('range="A20:A22"');
    expect(view).toContain("21| A21 21");
  });

  it("names the cells the person has selected, in A1", async () => {
    const fake = fakeSheets();
    await Effect.runPromise(
      fake.sheets.create("user", { conversationId: "conv-1", title: "Plan" }),
    );
    const tools = await prepare(fake, {
      documentId: "sheet-1",
      selected: ["s1", "s1.r3", "s1.c2", "s1.r2", "s1.c1"],
    });
    expect(send(tools)).toContain('selected="Sheet1!A2:B3"');
  });

  it("comments on a cell and shows the thread there", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    expect(
      await call(tools, "comment_on_document", { cell: "B2", content: "Is this right?" }),
    ).toMatchObject({ outcome: "commented" });
    expect(send(tools)).toContain('<thread id="t1" cell="Sheet1!B2" quote="Sheet1!B2">');
    expect(
      await call(tools, "comment_on_document", { cell: "Nope!B2", content: "x" }),
    ).toMatchObject({ outcome: "not_found" });
    // A reply changes no cell, yet the next view shows it.
    expect(
      await call(tools, "comment_on_document", { thread: "t1", content: "Checked twice." }),
    ).toMatchObject({ outcome: "commented" });
    expect(send(tools)).toContain("Checked twice.");
  });

  it("starts a sheet from a file the person gave, titled after it", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    expect(await call(tools, "create_sheet", { fromFile: "attachment:costs" })).toMatchObject({
      outcome: "created",
      title: "Costs",
    });
    expect(send(tools)).toContain('2| A2 "Tea" | B2 4');
    // Operations in the same call may write over the file's cells: the answer put them there.
    expect(
      await call(tools, "create_sheet", {
        fromFile: "attachment:costs",
        title: "Costs again",
        operations: [{ kind: "setCells", sheet: "Costs", start: "A2", rows: [["Coffee"]] }],
      }),
    ).toMatchObject({ outcome: "created" });
    expect(send(tools)).toContain('2| A2 "Coffee" | B2 4');
    expect(await call(tools, "create_sheet", { fromFile: "attachment:nope" })).toMatchObject({
      outcome: "invalid",
      message: "No file with that reference.",
    });
  });

  it("writes a streamed edit as it arrives, and the decoded call only what is left", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    send(tools);
    const operations = [
      { kind: "insertRows", sheet: "Sheet1", rows: "1" },
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["a"], ["b"], ["c"]] },
    ];
    const text = JSON.stringify({ operations });
    tools.live.start("call-1", "edit_sheet");
    await Effect.runPromise(tools.live.delta("call-1", text.slice(0, 90)));
    await Effect.runPromise(tools.live.delta("call-1", text.slice(90)));
    expect(await call(tools, "edit_sheet", { operations })).toMatchObject({ outcome: "updated" });
    const { doc } = fake.rows.get("sheet-1")!;
    // Inserted once, by the preview; the call found nothing left to write.
    expect(doc.sheet.s1!.rows).toHaveLength(1001);
    const firstRows = doc.sheet.s1!.rows.slice(0, 3).map((row) => row.id);
    expect(firstRows.map((r) => doc.sheet.s1!.cells[r]?.["s1.c1"]?.v)).toEqual(["a", "b", "c"]);
  });

  it("takes back a streamed edit no call claimed", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    send(tools);
    tools.live.start("call-1", "edit_sheet");
    await Effect.runPromise(
      tools.live.delta(
        "call-1",
        '{"operations":[{"kind":"setCells","sheet":"Sheet1","start":"B2","rows":[["half"],["writ',
      ),
    );
    await Effect.runPromise(tools.live.close);
    const { doc, document } = fake.rows.get("sheet-1")!;
    // The row that had arrived was written, then taken back.
    expect(document.revision).toBe(2);
    expect(doc.sheet.s1!.cells["s1.r2"]?.["s1.c2"]?.v ?? null).toBeNull();
  });

  it("takes back a streamed edit's writes, but not a person's edit between them", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    send(tools);
    const cell = (start: string, value: string) => ({
      kind: "setCells",
      sheet: "Sheet1",
      start,
      rows: [[value]],
    });
    const text = JSON.stringify({ operations: [cell("A1", "one"), cell("A3", "two")] });
    const second = text.indexOf('{"kind"', 20);
    tools.live.start("call-1", "edit_sheet");
    let wrote = fake.nextWrite();
    await Effect.runPromise(tools.live.delta("call-1", text.slice(0, second + 2)));
    await wrote;
    fake.personWrites("sheet-1", [
      { op: "set", sh: "s1", cells: [{ r: "s1.r5", c: "s1.c2", v: "person" }] },
    ]);
    wrote = fake.nextWrite();
    await Effect.runPromise(tools.live.delta("call-1", text.slice(second + 2, -2)));
    await wrote;
    await Effect.runPromise(tools.live.close);
    const { cells } = fake.rows.get("sheet-1")!.doc.sheet.s1!;
    expect([cells["s1.r1"]?.["s1.c1"]?.v ?? null, cells["s1.r3"]?.["s1.c1"]?.v ?? null]).toEqual([
      null,
      null,
    ]);
    expect(cells["s1.r5"]?.["s1.c2"]?.v).toBe("person");
  });

  it("takes back what a streamed edit wrote when its call is refused", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    await call(tools, "create_sheet", { title: "Plan" });
    send(tools);
    const operations = [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["one"]] },
      { kind: "setCells", sheet: "Nope", start: "A1", rows: [["two"]] },
    ];
    const text = JSON.stringify({ operations });
    tools.live.start("call-1", "edit_sheet");
    const wrote = fake.nextWrite();
    await Effect.runPromise(tools.live.delta("call-1", text.slice(0, text.indexOf("Nope"))));
    await wrote;
    expect(fake.rows.get("sheet-1")!.doc.sheet.s1!.cells["s1.r1"]?.["s1.c1"]?.v).toBe("one");
    expect(await call(tools, "edit_sheet", { operations })).not.toMatchObject({
      outcome: "updated",
    });
    expect(fake.rows.get("sheet-1")!.doc.sheet.s1!.cells["s1.r1"]?.["s1.c1"]?.v ?? null).toBeNull();
  });

  it("gives a streamed sheet the locale its call names after its operations", async () => {
    const fake = fakeSheets();
    const tools = await prepare(fake);
    const operations = [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["one"]] },
      { kind: "setCells", sheet: "Sheet1", start: "A2", rows: [["two"]] },
    ];
    const text = JSON.stringify({ title: "Plan", operations, locale: "de-DE" });
    tools.live.start("call-1", "create_sheet");
    const wrote = fake.nextWrite();
    await Effect.runPromise(tools.live.delta("call-1", text.slice(0, text.indexOf("A2") - 30)));
    await wrote;
    expect(
      await call(tools, "create_sheet", { title: "Plan", operations, locale: "de-DE" }),
    ).toMatchObject({
      outcome: "created",
    });
    expect(fake.rows.get("sheet-1")!.doc.settings.locale).toBe("de-DE");
  });
});
