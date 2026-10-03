// Loaded by the PDF worker under plain Node in development: relative imports only.
import { availableParallelism } from "node:os";
import {
  classifyPage,
  imageCoverage,
  inkShare,
  stripControlCharacters,
  type PageKind,
} from "../classify.ts";
import { PDF_RASTER } from "../limits.ts";
import { JobError } from "../../../server/job-worker.ts";
import { createOcrEngine, type OcrEngine, type OcrModelPaths } from "./ocr/engine.ts";
import { fromRgba } from "./ocr/image.ts";

export interface PageRead {
  readonly text: string;
  readonly kind: PageKind;
}

const canvasModule = () => import("@napi-rs/canvas");

/** pdf.js with a canvas wired in, loaded once per worker. */
let pdfjs: Promise<{
  getDocument: typeof import("unpdf/pdfjs").getDocument;
  OPS: typeof import("unpdf/pdfjs").OPS;
  CanvasFactory: unknown;
}> | null = null;
const loadPdfjs = () =>
  (pdfjs ??= (async () => {
    const { getResolvedPDFJS, createIsomorphicCanvasFactory } = await import("unpdf");
    const { getDocument, OPS } = await getResolvedPDFJS();
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasModule);
    return { getDocument, OPS, CanvasFactory };
  })());

async function open(bytes: Uint8Array) {
  const { getDocument, CanvasFactory } = await loadPdfjs();
  // pdf.js detaches the buffer it is given; this one is the worker's own copy.
  const task = getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    CanvasFactory,
  } as Parameters<typeof getDocument>[0]);
  try {
    return { document: await task.promise, close: () => task.destroy() };
  } catch {
    await task.destroy();
    throw new JobError("unreadable", "could not read the PDF");
  }
}

type PdfDocument = Awaited<ReturnType<typeof open>>["document"];
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

/** Scale for a render whose long edge is `longEdge`, never past the pixel cap. */
function scaleFor(page: PdfPage, longEdge: number) {
  const { width, height } = page.getViewport({ scale: 1 });
  return longEdge / Math.max(width, height, 1);
}

/**
 * Renders at `scale`, or smaller when that would pass the pixel cap: a page
 * may declare any size, and canvas memory is native, outside the heap bound.
 */
async function draw(page: PdfPage, requested: number) {
  const { createCanvas } = await canvasModule();
  const base = page.getViewport({ scale: 1 });
  const byPixels = Math.sqrt(PDF_RASTER.maxPixels / Math.max(base.width * base.height, 1));
  const viewport = page.getViewport({ scale: Math.min(requested, byPixels) });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  // Paper is white; a transparent page would otherwise read as black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  // pdf.js types its target as a DOM canvas; this one draws the same way in Node.
  await page.render({ canvas: canvas as never, viewport }).promise;
  return { canvas, context, width, height };
}

/**
 * Text and kind of each page up to `maxPages`, stopping once the text layer
 * passes `maxChars`. A document over `maxPages` that must be complete is
 * answered with its page count alone, so nothing is read that will be refused.
 */
export async function readPages(request: {
  readonly bytes: Uint8Array;
  readonly maxPages: number;
  readonly maxChars: number;
  readonly requireComplete?: boolean;
}) {
  const { OPS } = await loadPdfjs();
  const { document, close } = await open(request.bytes);
  try {
    const totalPages = document.numPages;
    if (request.requireComplete && totalPages > request.maxPages)
      return { totalPages, pages: [] as PageRead[] };
    const ops = {
      save: OPS.save,
      restore: OPS.restore,
      transform: OPS.transform,
      formBegin: OPS.paintFormXObjectBegin,
      formEnd: OPS.paintFormXObjectEnd,
      images: new Set([
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObjectGroup,
      ]),
    };
    const pages: PageRead[] = [];
    let chars = 0;
    for (let number = 1; number <= Math.min(totalPages, request.maxPages); number++) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time bounds pdf.js's work
      const page = await document.getPage(number);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const content = await page.getTextContent();
      // Private-use glyphs surface as NUL and stray controls, which Postgres
      // refuses in text columns; strip them here, upstream of every reader.
      const text = stripControlCharacters(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
          .join(""),
      ).trim();
      const glyphs = text.replace(/\s/g, "").length;
      // oxlint-disable-next-line no-await-in-loop -- see above
      const operators = await page.getOperatorList();
      const coverage = imageCoverage(page.view as [number, number, number, number], operators, ops);
      let kind = classifyPage({ chars: glyphs, coverage, ink: null });
      if (kind === "needs-ink") {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const small = await draw(page, PDF_RASTER.inkScale);
        kind = classifyPage({
          chars: glyphs,
          coverage,
          ink: inkShare(small.context.getImageData(0, 0, small.width, small.height).data),
        });
      }
      // A scan keeps its text layer too: shown when the page is not read, replaced when it is.
      pages.push({ text, kind: kind === "needs-ink" ? "scan" : kind });
      page.cleanup();
      chars += text.length;
      if (chars > request.maxChars) break;
    }
    return { totalPages, pages };
  } finally {
    await close();
  }
}

/** Pages as images for a model to look at, JPEG to keep the prompt small. */
export async function renderPages(request: {
  readonly bytes: Uint8Array;
  readonly pages: readonly number[];
  readonly longEdge: number;
}) {
  const { document, close } = await open(request.bytes);
  try {
    const images: Array<{ page: number; bytes: Uint8Array; width: number; height: number }> = [];
    for (const number of request.pages) {
      if (number < 1 || number > document.numPages) continue;
      // oxlint-disable-next-line no-await-in-loop -- one page at a time bounds memory
      const page = await document.getPage(number);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const drawn = await draw(page, scaleFor(page, request.longEdge));
      // oxlint-disable-next-line no-await-in-loop -- see above
      const bytes = await drawn.canvas.encode("jpeg", 85);
      images.push({
        page: number,
        bytes: new Uint8Array(bytes),
        width: drawn.width,
        height: drawn.height,
      });
      page.cleanup();
    }
    return images;
  } finally {
    await close();
  }
}

/** One engine per model files, kept for the worker's life: loading costs more than a page. */
const engines = new Map<string, Promise<OcrEngine>>();

/** Text of each page, read from its image on this server. */
export async function ocrPages(request: {
  readonly bytes: Uint8Array;
  readonly pages: readonly number[];
  readonly models: OcrModelPaths;
  readonly threads?: number;
}) {
  const key = `${request.models.detection}\n${request.models.recognition}`;
  let engine = engines.get(key);
  if (!engine) {
    const threads = Math.max(1, Math.min(request.threads ?? availableParallelism(), 8));
    // Two failures told apart: a missing native runtime is a broken install,
    // unusable files are a download to repeat.
    // ONNX Runtime 1.30 reports usage to Microsoft from Linux and macOS unless
    // told not to before it loads; "nothing leaves this server" must hold.
    process.env.ORT_DISABLE_TELEMETRY = "1";
    engine = import("onnxruntime-node")
      .catch(() => {
        throw new JobError(
          "runtime_unavailable",
          "text recognition is not installed on this server",
        );
      })
      .then((ort) =>
        createOcrEngine(ort, request.models, threads).catch(() => {
          throw new JobError(
            "models_unavailable",
            "the text recognition files could not be loaded",
          );
        }),
      );
    engines.set(key, engine);
    // A failed load is not kept, so files repaired later are picked up.
    engine.catch(() => engines.delete(key));
  }
  const ready = await engine;
  const { document, close } = await open(request.bytes);
  try {
    const read: Array<{ page: number; text: string }> = [];
    for (const number of request.pages) {
      if (number < 1 || number > document.numPages) continue;
      // oxlint-disable-next-line no-await-in-loop -- one page at a time bounds memory
      const page = await document.getPage(number);
      // oxlint-disable-next-line no-await-in-loop -- see above
      const drawn = await draw(page, scaleFor(page, PDF_RASTER.ocrLongEdge));
      const image = fromRgba(
        drawn.context.getImageData(0, 0, drawn.width, drawn.height).data,
        drawn.width,
        drawn.height,
      );
      page.cleanup();
      // oxlint-disable-next-line no-await-in-loop -- see above
      read.push({ page: number, text: stripControlCharacters(await ready.read(image)) });
    }
    return read;
  } finally {
    await close();
  }
}

/**
 * A PDF of just `pages`, for a service that reads whole documents: copied
 * when the file allows it, so the scans keep their own resolution, and
 * rebuilt from renders when it does not (an encrypted file, a broken structure).
 */
export async function subsetPages(request: {
  readonly bytes: Uint8Array;
  readonly pages: readonly number[];
}) {
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.create();
  try {
    const source = await PDFDocument.load(request.bytes, { updateMetadata: false });
    const copied = await output.copyPages(
      source,
      request.pages.map((page) => page - 1),
    );
    for (const page of copied) output.addPage(page);
    return new Uint8Array(await output.save());
  } catch {
    const rebuilt = await PDFDocument.create();
    for (const image of await renderPages({ ...request, longEdge: 2000 })) {
      // oxlint-disable-next-line no-await-in-loop -- pages are added in order
      const embedded = await rebuilt.embedJpg(image.bytes);
      rebuilt.addPage([image.width, image.height]).drawImage(embedded, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      });
    }
    return new Uint8Array(await rebuilt.save());
  }
}
