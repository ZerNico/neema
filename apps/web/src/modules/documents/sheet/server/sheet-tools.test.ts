import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { EditableDocument } from "../../schema.ts";
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
    create: (_userId, input) =>
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
          doc: emptyDoc("Sheet1", { locale: input.locale ?? "en-US", timeZone: "UTC" }),
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
              comments: [],
            }
          : null;
      }),
    change: (_userId, input, _guard, decide) =>
      Effect.gen(function* () {
        const row = rows.get(input.documentId)!;
        const decided = yield* decide(row.doc, row.document);
        if (!decided.ops?.length)
          return { result: decided.result, document: row.document, refused: null, dropped: [] };
        const written = commit(input.documentId, input.clientId, [...decided.ops], "model");
        return { result: decided.result, ...written, refused: null };
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
  return { sheets, service, rows, personWrites };
}

const prepare = (
  fake: ReturnType<typeof fakeSheets>,
  open?: { documentId: string; selected: string[] },
) =>
  Effect.runPromise(
    prepareDocumentTools({
      service: fake.service as DocumentToolService,
      sheets: fake.sheets,
      ...(open ? { openDocumentId: open.documentId, selectedBlocks: open.selected } : {}),
      generationId: "g1",
      userId: "user",
      conversationId: "conv-1",
      messageId: "message-1",
      writeGuard: () => Effect.void,
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
});
