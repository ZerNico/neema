import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XLSX_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { createWorkingFiles } from "~/modules/chat/server/working-files.ts";
import { createSpreadsheet, editSpreadsheet } from "./adapter.ts";
import { createSpreadsheetRuntime, type SpreadsheetRuntime } from "./runtime.ts";
import { prepareSpreadsheetTools, type SpreadsheetToolResult } from "./tools.ts";

const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invoke = (handler: unknown, params: unknown) =>
  Effect.runPromise((handler as (params: unknown) => Effect.Effect<SpreadsheetToolResult>)(params));
const workerUrl = new URL("./runtime-worker.ts", import.meta.url);

let runtime: SpreadsheetRuntime;
beforeAll(() => {
  runtime = createSpreadsheetRuntime(workerUrl, { workers: 1 });
});
afterAll(() => runtime.close());

describe("spreadsheet tool group", () => {
  it("creates and edits private drafts, calculates, and checks revisions", async () => {
    const workingFiles = createWorkingFiles();
    const { group } = prepareSpreadsheetTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      expect((await invoke(group.handlers.inspect_spreadsheet, {})).message).toBe(
        "invalid_operation: Provide exactly one of sourceRef or workingRef.",
      );
      const created = await invoke(group.handlers.edit_spreadsheet, {
        create: true,
        fileName: "Budget.xlsx",
        operations: [
          {
            kind: "setCells",
            sheet: "Sheet1",
            start: "A1",
            rows: [
              ["Item", "Cost"],
              ["Rent", 900],
              ["Food", 300],
              ["Total", "=SUM(B2:B3)"],
              ["Share", "=B4/0"],
            ],
          },
        ],
      });
      expect(created).toMatchObject({
        outcome: "working",
        origin: "created",
        revision: 1,
        cellsWritten: 10,
        changes: "Wrote a cell range",
        formulaErrors: { count: 1, cells: [{ cell: "Sheet1!B5", error: "#DIV/0!" }] },
      });
      expect(created.message).toMatch(/1 formula evaluate to an error/);
      expect(created.formulaResults).toEqual(
        expect.arrayContaining([expect.objectContaining({ cell: "B4", value: "1200" })]),
      );
      const workingRef = created.workingRef!;
      const inspected = await invoke(group.handlers.inspect_spreadsheet, {
        workingRef,
        range: "A4:B4",
      });
      expect(inspected).toMatchObject({
        outcome: "complete",
        read: { sheet: 1, range: "A4:B4" },
        window: {
          cells: [
            { cell: "A4", value: "Total" },
            { cell: "B4", value: "1200", formula: "=SUM(B2:B3)" },
          ],
        },
      });
      const fixed = await invoke(group.handlers.edit_spreadsheet, {
        workingRef,
        operations: [{ kind: "setCells", sheet: "Sheet1", start: "B5", rows: [["=B4/2"]] }],
      });
      expect(fixed).toMatchObject({ revision: 2, formulaErrors: { count: 0 } });
      // The first revision is gone once the draft moved on.
      expect((await invoke(group.handlers.inspect_spreadsheet, { workingRef })).outcome).toBe(
        "error",
      );
      // A failing operation leaves the draft where it was.
      const refused = await invoke(group.handlers.edit_spreadsheet, {
        workingRef: fixed.workingRef,
        operations: [
          { kind: "setCells", sheet: "Sheet1", start: "C1", rows: [[1]] },
          { kind: "deleteSheet", sheet: "Nope" },
        ],
      });
      expect(refused).toMatchObject({
        outcome: "error",
        message: expect.stringContaining("operations[1] deleteSheet"),
      });
      expect(
        workingFiles.read({ kind: "working", id: fixed.workingFileId!, revision: 2 }).fingerprint,
      ).toBe(fixed.fingerprint);
    } finally {
      workingFiles.dispose();
    }
  });

  it("opens an authorized source only with its fingerprint, and never a non-workbook", async () => {
    const base = await editSpreadsheet(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["Plan"]] },
    ]);
    const attachment = { kind: "attachment" as const, id: "01990f4e-6650-7a33-a768-611e2e4bf4c7" };
    const files = {
      [`attachment:${attachment.id}`]: {
        name: "plan.xlsx",
        mediaType: XLSX_MEDIA_TYPE,
        bytes: base.bytes,
      },
    };
    const workingFiles = createWorkingFiles();
    const { group } = prepareSpreadsheetTools({
      runtime,
      workingFiles,
      resolveFile: (reference) => {
        const file = files[reference as keyof typeof files];
        return file
          ? Effect.succeed({
              ...file,
              ref: attachment,
              source: { kind: "chat", attachmentId: attachment.id },
            })
          : Effect.fail("No such file.");
      },
    });
    try {
      const sourceRef = `attachment:${attachment.id}`;
      expect(
        (await invoke(group.handlers.edit_spreadsheet, { sourceRef, operations: [] })).message,
      ).toMatch(/inspect the source first/);
      const inspected = await invoke(group.handlers.inspect_spreadsheet, { sourceRef });
      expect(inspected).toMatchObject({ sourceRef, fingerprint: fingerprint(base.bytes) });
      const opened = await invoke(group.handlers.edit_spreadsheet, {
        sourceRef,
        sourceFingerprint: inspected.fingerprint,
        operations: [{ kind: "setCells", sheet: "Sheet1", start: "A2", rows: [["Next"]] }],
      });
      expect(opened).toMatchObject({ origin: "opened", outcome: "working" });
      expect(
        workingFiles.read({ kind: "working", id: opened.workingFileId!, revision: 1 }),
      ).toMatchObject({
        name: "plan.xlsx",
        owner: "spreadsheet",
        source: sourceRef,
      });
      // A deck or any other draft is not a spreadsheet draft.
      const other = workingFiles.create({
        bytes: new Uint8Array([1]),
        name: "deck.pptx",
        mediaType: "application/octet-stream",
        owner: "presentation",
      });
      expect(
        (
          await invoke(group.handlers.edit_spreadsheet, {
            workingRef: `working:${other.ref.id}@1`,
            operations: [],
          })
        ).message,
      ).toMatch(/workingRef: this working file is not/);
      // A workbook imported from the computer is a source, opened into a draft of its own.
      const imported = workingFiles.create({
        bytes: base.bytes,
        name: "local.xlsx",
        mediaType: XLSX_MEDIA_TYPE,
        owner: "local",
      });
      const fromLocal = await invoke(group.handlers.edit_spreadsheet, {
        sourceRef: `working:${imported.ref.id}@1`,
        operations: [],
      });
      expect(fromLocal).toMatchObject({ outcome: "working", origin: "opened" });
      expect(fromLocal.workingFileId).not.toBe(imported.ref.id);
    } finally {
      workingFiles.dispose();
    }
  });
});
