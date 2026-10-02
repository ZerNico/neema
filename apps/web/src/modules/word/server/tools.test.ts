import { createHash } from "node:crypto";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCX_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { createWorkingFiles } from "~/modules/chat/server/working-files.ts";
import { createWordFile, editWordFile } from "./adapter.ts";
import { createWordRuntime, type WordRuntime } from "./runtime.ts";
import { prepareWordTools, type WordToolResult } from "./tools.ts";

const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invoke = (handler: unknown, params: unknown) =>
  Effect.runPromise((handler as (params: unknown) => Effect.Effect<WordToolResult>)(params));
const workerUrl = new URL("./runtime-worker.ts", import.meta.url);

let runtime: WordRuntime;
beforeAll(() => {
  runtime = createWordRuntime(workerUrl, { workers: 1 });
});
afterAll(() => runtime.close());

describe("Word tool group", () => {
  it("creates and edits private drafts and checks revisions", async () => {
    const workingFiles = createWorkingFiles();
    const { group } = prepareWordTools({
      runtime,
      workingFiles,
      resolveFile: () => Effect.fail("Not available"),
    });
    try {
      expect((await invoke(group.handlers.inspect_word_file, {})).message).toBe(
        "invalid_operation: Provide exactly one of sourceRef or workingRef.",
      );
      const created = await invoke(group.handlers.edit_word_file, {
        create: true,
        fileName: "Letter.docx",
        operations: [
          {
            kind: "insertParagraphs",
            at: "start",
            paragraphs: [{ text: "Offer", style: "heading1" }, { text: "Dear {{name}}," }],
          },
        ],
      });
      expect(created).toMatchObject({
        outcome: "working",
        origin: "created",
        revision: 1,
        changes: "Inserted a passage",
        results: [{ operation: 0, blocks: "0-1" }],
      });
      const workingRef = created.workingRef!;
      const inspected = await invoke(group.handlers.inspect_word_file, { workingRef });
      expect(inspected).toMatchObject({
        outcome: "complete",
        read: { from: 0, blockCount: 3 },
        document: { placeholders: ["{{name}}"], outline: [{ block: 0, level: 1, text: "Offer" }] },
      });
      const filled = await invoke(group.handlers.edit_word_file, {
        workingRef,
        operations: [{ kind: "replaceText", find: "{{name}}", replace: "Ada" }],
      });
      expect(filled).toMatchObject({ revision: 2, results: [{ operation: 0, replaced: 1 }] });
      // The first revision is gone once the draft moved on.
      expect((await invoke(group.handlers.inspect_word_file, { workingRef })).outcome).toBe(
        "error",
      );
      // A failing operation leaves the draft where it was.
      const refused = await invoke(group.handlers.edit_word_file, {
        workingRef: filled.workingRef,
        operations: [
          { kind: "insertParagraphs", at: "end", paragraphs: [{ text: "PS" }] },
          { kind: "setParagraph", block: 99, text: "nope" },
        ],
      });
      expect(refused).toMatchObject({
        outcome: "error",
        message: expect.stringContaining("operations[1] setParagraph"),
      });
      expect(
        workingFiles.read({ kind: "working", id: filled.workingFileId!, revision: 2 }).fingerprint,
      ).toBe(filled.fingerprint);
    } finally {
      workingFiles.dispose();
    }
  });

  it("opens an authorized source only with its fingerprint, and never another kind of file", async () => {
    const base = editWordFile(createWordFile(), [
      { kind: "insertParagraphs", at: "start", paragraphs: [{ text: "Plan" }] },
    ]);
    const attachment = { kind: "attachment" as const, id: "01990f4e-6650-7a33-a768-611e2e4bf4c7" };
    const files = {
      [`attachment:${attachment.id}`]: {
        name: "plan.docx",
        mediaType: DOCX_MEDIA_TYPE,
        bytes: base.bytes,
      },
    };
    const workingFiles = createWorkingFiles();
    const { group } = prepareWordTools({
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
        (await invoke(group.handlers.edit_word_file, { sourceRef, operations: [] })).message,
      ).toMatch(/inspect the source first/);
      const inspected = await invoke(group.handlers.inspect_word_file, { sourceRef });
      expect(inspected).toMatchObject({ sourceRef, fingerprint: fingerprint(base.bytes) });
      const opened = await invoke(group.handlers.edit_word_file, {
        sourceRef,
        sourceFingerprint: inspected.fingerprint,
        operations: [{ kind: "insertParagraphs", after: 0, paragraphs: [{ text: "Next" }] }],
      });
      expect(opened).toMatchObject({ origin: "opened", outcome: "working" });
      expect(
        workingFiles.read({ kind: "working", id: opened.workingFileId!, revision: 1 }),
      ).toMatchObject({
        name: "plan.docx",
        owner: "word",
        source: sourceRef,
      });
      const other = workingFiles.create({
        bytes: new Uint8Array([1]),
        name: "book.xlsx",
        mediaType: "application/octet-stream",
        owner: "spreadsheet",
      });
      expect(
        (
          await invoke(group.handlers.edit_word_file, {
            workingRef: `working:${other.ref.id}@1`,
            operations: [],
          })
        ).message,
      ).toMatch(/workingRef: this working file is not/);
      const imported = workingFiles.create({
        bytes: base.bytes,
        name: "local.docx",
        mediaType: DOCX_MEDIA_TYPE,
        owner: "local",
      });
      const fromLocal = await invoke(group.handlers.edit_word_file, {
        sourceRef: `working:${imported.ref.id}@1`,
        operations: [],
      });
      expect(fromLocal).toMatchObject({ outcome: "working", origin: "opened" });
      expect(fromLocal.workingFileId).not.toBe(imported.ref.id);
    } finally {
      workingFiles.dispose();
    }
  });

  it("places a picture from an authorized file, and refuses one that isn't a picture", async () => {
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgQEADgMCAXl3Jk0AAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const files: Record<string, { name: string; mediaType: string; bytes: Uint8Array }> = {
      "attachment:01990f4e-6650-7a33-a768-611e2e4bf4c8": {
        name: "chart.png",
        mediaType: "image/png",
        bytes: png,
      },
      "attachment:01990f4e-6650-7a33-a768-611e2e4bf4c9": {
        name: "notes.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("hello"),
      },
    };
    const workingFiles = createWorkingFiles();
    const { group } = prepareWordTools({
      runtime,
      workingFiles,
      resolveFile: (reference) => {
        const file = files[reference];
        const id = reference.slice("attachment:".length);
        return file
          ? Effect.succeed({
              ...file,
              ref: { kind: "attachment" as const, id },
              source: { kind: "chat", attachmentId: id },
            })
          : Effect.fail("No such file.");
      },
    });
    try {
      const made = await invoke(group.handlers.edit_word_file, {
        create: true,
        operations: [
          {
            kind: "insertImage",
            at: "start",
            imageRef: "attachment:01990f4e-6650-7a33-a768-611e2e4bf4c8",
            width: 4,
          },
        ],
      });
      expect(made).toMatchObject({ outcome: "working", changes: "Inserted a picture" });
      const inspected = await invoke(group.handlers.inspect_word_file, {
        workingRef: made.workingRef,
      });
      expect(inspected.document).toMatchObject({ images: 1 });
      expect(inspected.document.blocks[0]).toMatchObject({ block: 0, pictures: 1 });
      const refused = await invoke(group.handlers.edit_word_file, {
        create: true,
        operations: [
          {
            kind: "insertImage",
            at: "start",
            imageRef: "attachment:01990f4e-6650-7a33-a768-611e2e4bf4c9",
          },
        ],
      });
      expect(refused.message).toMatch(/not a PNG or JPEG picture/);
      const unknown = await invoke(group.handlers.edit_word_file, {
        create: true,
        operations: [
          {
            kind: "insertImage",
            at: "start",
            imageRef: "attachment:01990f4e-6650-7a33-a768-611e2e4bf4ca",
          },
        ],
      });
      expect(unknown).toMatchObject({
        outcome: "error",
        message: expect.stringContaining("No such file"),
      });
    } finally {
      workingFiles.dispose();
    }
  });
});
