import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/pdf.ts";
import { buildScannedPdf } from "../../../../tests/fixtures/scanned-pdf.ts";
import { createPdfRuntime } from "./runtime.ts";

const runtime = createPdfRuntime(new URL("./runtime-worker.ts", import.meta.url));
afterAll(() => runtime.close());

const JPEG = [0xff, 0xd8, 0xff];
// The files the app downloads when local reading is turned on; absent, the
// recognition test is skipped rather than fetching 31 MB in a test run.
const models = resolve(process.env.OCR_MODEL_ROOT ?? ".data/ocr-models", "ppocrv6-small");

describe("PDF worker", () => {
  it("reads the text layer and tells text, scanned, outlined and blank pages apart", async () => {
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Quarterly report for the board" },
      { kind: "scan", text: "Invoice 2026-114" },
      { kind: "scan", text: "Signed copy", stamp: "Gescannt am 03.10.2026 von Kopierer 4" },
      { kind: "outlined" },
      { kind: "blank" },
    ]);
    const read = await runtime.run({ kind: "read", bytes, maxPages: 10, maxChars: 10_000 });
    expect(read.totalPages).toBe(5);
    expect(read.pages.map((page) => page.kind)).toEqual(["text", "scan", "scan", "scan", "blank"]);
    expect(read.pages[0]!.text).toContain("Quarterly report");
    // A scanner's stamp is a text layer, kept for when the page is not read.
    expect(read.pages[2]!.text).toContain("Gescannt am");
  });

  it("keeps a page's short text layer, however large its letters", async () => {
    const { PDFDocument: Doc, StandardFonts } = await import("pdf-lib");
    const document = await Doc.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage([595, 842]).drawText("PAID", { x: 100, y: 400, size: 72, font });
    const read = await runtime.run({
      kind: "read",
      bytes: new Uint8Array(await document.save()),
      maxPages: 1,
      maxChars: 100,
    });
    expect(read.pages).toEqual([{ kind: "text", text: "PAID" }]);
  });

  it("never renders past the pixel cap, whatever size a page declares", async () => {
    const { PDFDocument: Doc } = await import("pdf-lib");
    const document = await Doc.create();
    document.addPage([14_400, 14_400]).drawRectangle({ x: 0, y: 0, width: 100, height: 100 });
    const [image] = await runtime.run({
      kind: "render",
      bytes: new Uint8Array(await document.save()),
      pages: [1],
      longEdge: 100_000,
    });
    expect(image!.width * image!.height).toBeLessThanOrEqual(4_000_000);
  });

  it("answers a document over its page limit with the count alone when it must be complete", async () => {
    const bytes = buildPdf(["one", "two", "three"]);
    const read = await runtime.run({
      kind: "read",
      bytes,
      maxPages: 2,
      maxChars: 10_000,
      requireComplete: true,
    });
    expect(read).toEqual({ totalPages: 3, pages: [] });
  });

  it("stops reading once the text passes the character limit", async () => {
    // A line longer than the page is clipped by pdf.js, so each page holds a line that fits.
    const bytes = buildPdf(["a".repeat(60), "b".repeat(60), "c".repeat(60)]);
    const read = await runtime.run({ kind: "read", bytes, maxPages: 10, maxChars: 100 });
    expect(read.pages).toHaveLength(2);
  });

  it("renders pages as JPEG within the requested size", async () => {
    const bytes = await buildScannedPdf([{ kind: "scan", text: "Render me" }]);
    const [image] = await runtime.run({ kind: "render", bytes, pages: [1], longEdge: 800 });
    expect([...image!.bytes.subarray(0, 3)]).toEqual(JPEG);
    expect(Math.max(image!.width, image!.height)).toBe(800);
  });

  it("cuts a PDF down to the scanned pages, in the order asked", async () => {
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover" },
      { kind: "scan", text: "Two" },
      { kind: "scan", text: "Three" },
    ]);
    const subset = await runtime.run({ kind: "subset", bytes, pages: [2, 3] });
    expect((await PDFDocument.load(subset)).getPageCount()).toBe(2);
  });

  it("refuses bytes that are not a PDF, with a reason", async () => {
    await expect(
      runtime.run({
        kind: "read",
        bytes: new TextEncoder().encode("not a pdf"),
        maxPages: 1,
        maxChars: 10,
      }),
    ).rejects.toMatchObject({ code: "unreadable" });
  });

  it("names unusable model files instead of crashing the worker", async () => {
    const bytes = await buildScannedPdf([{ kind: "scan", text: "No models" }]);
    await expect(
      runtime.run({
        kind: "ocr",
        bytes,
        pages: [1],
        models: {
          detection: "/nope/det.onnx",
          recognition: "/nope/rec.onnx",
          recognitionConfig: "/nope/rec.yml",
        },
      }),
    ).rejects.toMatchObject({ code: "models_unavailable" });
  });

  it.skipIf(!existsSync(resolve(models, "rec.yml")))(
    "reads a scanned page's words on this server",
    async () => {
      const bytes = await buildScannedPdf([
        { kind: "scan", text: "Rechnung Nummer 4711 vom Oktober" },
      ]);
      const [page] = await runtime.run({
        kind: "ocr",
        bytes,
        pages: [1],
        threads: 2,
        models: {
          detection: resolve(models, "det.onnx"),
          recognition: resolve(models, "rec.onnx"),
          recognitionConfig: resolve(models, "rec.yml"),
        },
      });
      expect(page!.page).toBe(1);
      expect(page!.text).toMatch(/Rechnung\s*Nummer\s*4711\s*vom\s*Oktober/);
    },
    60_000,
  );
});
