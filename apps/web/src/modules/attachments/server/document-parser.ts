import { Context, Effect, Layer } from "effect";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { DocumentParseError } from "../errors.ts";

export interface ParsedDocument {
  text: string;
  /** Parser kind the text came from; cached alongside it to invalidate later. */
  parsedWith: string;
  truncated: boolean;
  /** 1-based pages with no text layer (scans). Present only when some were skipped. */
  skippedPages?: ReadonlyArray<number>;
}

export interface DocumentParserAvailability {
  configured: boolean;
  enabled: boolean;
  kind: string | null;
}

/**
 * Extracts text from documents the model cannot ingest natively. Deliberately
 * local: shipping a user's PDF to a third-party parsing service would be an
 * outbound copy of their data that nothing else in this app makes.
 *
 * The backend is selected by the `kind` column of the `document_parser` row in
 * the tools registry, so an OCR-capable or remote parser can be added later
 * without touching any caller.
 */
export class DocumentParser extends Context.Service<
  DocumentParser,
  {
    parsePdf(input: {
      bytes: Uint8Array;
      fileName: string;
      /**
       * Overrides the configured page/character bounds. The tool row's limits
       * are tuned for inlining a PDF into one prompt; a knowledge collection
       * indexes the document instead and can afford, and needs, more of it.
       */
      limits?: { maxChars: number; maxPages: number };
      /** Knowledge must never publish a prompt-truncated PDF as complete. */
      requireComplete?: boolean;
    }): Effect.Effect<ParsedDocument, DocumentParseError>;
    availability(): Effect.Effect<DocumentParserAvailability>;
  }
>()("chat/attachments/DocumentParser") {
  static readonly layer = Layer.effect(
    DocumentParser,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;

      const availability = Effect.fn("DocumentParser.availability")(function* () {
        const row = yield* repo.getDocumentParser();
        return {
          configured: row !== null,
          enabled: row?.enabled ?? false,
          kind: row?.kind ?? null,
        } satisfies DocumentParserAvailability;
      });

      const parsePdf = Effect.fn("DocumentParser.parsePdf")(function* (input: {
        bytes: Uint8Array;
        fileName: string;
        limits?: { maxChars: number; maxPages: number };
        requireComplete?: boolean;
      }) {
        const row = yield* repo.getDocumentParser();
        if (!row || !row.enabled) {
          return yield* new DocumentParseError({
            fileName: input.fileName,
            reason: "document parsing is disabled",
          });
        }
        if (row.kind !== "local") {
          return yield* new DocumentParseError({
            fileName: input.fileName,
            reason: `unknown document parser backend "${row.kind}"`,
          });
        }
        return yield* parseLocalPdf(input, input.limits ?? row.config);
      });

      return DocumentParser.of({ parsePdf, availability });
    }),
  );
}

export const LOCAL_PARSER_KIND = "local";
/** Bump whenever PDF extraction semantics change. */
export const PDF_EXTRACTION_REVISION = 2;

/** Removes NUL and other C0/DEL controls, keeping tab, newline and carriage return. */
export const stripControlCharacters = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- the whole point is the control range
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

const parseLocalPdf = Effect.fn("DocumentParser.parseLocalPdf")(function* (
  input: { bytes: Uint8Array; fileName: string; requireComplete?: boolean },
  config: { maxChars: number; maxPages: number },
) {
  const { pages, totalPages, skipped } = yield* Effect.tryPromise({
    try: async (signal) => {
      // pdf.js is heavy and only needed when a non-native model meets a PDF.
      const { getResolvedPDFJS } = await import("unpdf");
      signal.throwIfAborted();
      const { getDocument } = await getResolvedPDFJS();
      signal.throwIfAborted();
      // Mirror unpdf 1.8.1's getDocumentProxy defaults, but retain the loading
      // task before awaiting its promise so cancellation also stops acquisition.
      let nodeDefaults = {};
      try {
        const base = import.meta.resolve("pdfjs-dist/package.json");
        nodeDefaults = {
          disableFontFace: true,
          standardFontDataUrl: new URL("./standard_fonts/", base).href,
          cMapUrl: new URL("./cmaps/", base).href,
          cMapPacked: true,
        };
      } catch {
        // Optional pdfjs-dist assets are absent with the serverless bundle.
      }
      // pdf.js transfers (and detaches) the buffer it is given; copy so the
      // caller's bytes stay usable, since the same blob may be sent natively too.
      const loadingTask = getDocument({
        data: new Uint8Array(input.bytes),
        useSystemFonts: true,
        ...nodeDefaults,
      });
      let destruction: Promise<void> | undefined;
      const destroy = () => (destruction ??= loadingTask.destroy());
      const abort = () => {
        void destroy().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        const document = await loadingTask.promise;
        signal.throwIfAborted();
        if (input.requireComplete && document.numPages > config.maxPages) {
          throw new DocumentParseError({
            fileName: input.fileName,
            reason: `PDF exceeds the ${config.maxPages}-page limit; split it into smaller documents`,
          });
        }
        const extractedPages: string[] = [];
        const skipped: number[] = [];
        let chars = 0;
        // A single page at a time bounds pdf.js work; stop as soon as the
        // character limit is known instead of extracting hundreds more pages.
        for (let index = 0; index < Math.min(document.numPages, config.maxPages); index++) {
          signal.throwIfAborted();
          const page = await document.getPage(index + 1);
          const content = await page.getTextContent();
          signal.throwIfAborted();
          // Private-use glyphs (event-ticket emoji, dingbats) surface as U+0000
          // and stray C0 controls in pdf.js text runs. Postgres rejects NUL in
          // text columns, so leaving them in silently kills publication on every
          // attempt, indistinguishable from a timeout. Strip here, upstream of
          // both attachment prompts and knowledge indexing.
          const text = stripControlCharacters(
            content.items
              .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
              .join(""),
          ).trim();
          // Without OCR a textless page may be a scan, not an empty page. It
          // is skipped and reported, never silently treated as empty: the
          // caller marks the version incomplete so coverage is disclosed.
          if (!text) skipped.push(index + 1);
          extractedPages.push(text);
          chars += `[page ${index + 1}]\n${text}`.length + (index > 0 ? 2 : 0);
          if (chars > config.maxChars) {
            if (input.requireComplete)
              throw new DocumentParseError({
                fileName: input.fileName,
                reason: `PDF exceeds the ${config.maxChars}-character extraction limit; split it into smaller documents`,
              });
            break;
          }
          page.cleanup();
        }
        return { pages: extractedPages, totalPages: document.numPages, skipped };
      } finally {
        signal.removeEventListener("abort", abort);
        await destroy();
      }
    },
    catch: (error) =>
      error instanceof DocumentParseError
        ? error
        : new DocumentParseError({
            fileName: input.fileName,
            reason: error instanceof Error ? error.message : "could not read the PDF",
          }),
  });

  // A skipped page keeps its marker so page numbers stay aligned with the
  // original; the marker line alone is what a reader sees there.
  const joined = pages
    .map((page, index) => `[page ${index + 1}]\n${page.trim()}`.trimEnd())
    .join("\n\n")
    .trim();

  if (joined.replace(/\[page \d+\]/g, "").trim() === "") {
    return yield* new DocumentParseError({
      fileName: input.fileName,
      reason: "no extractable text (the PDF is probably a scan)",
    });
  }

  const truncated = joined.length > config.maxChars || totalPages > pages.length;
  const text = joined.length > config.maxChars ? joined.slice(0, config.maxChars) : joined;
  return {
    text: truncated ? `${text}\n\n[document truncated]` : text,
    parsedWith: LOCAL_PARSER_KIND,
    truncated,
    ...(skipped.length > 0 ? { skippedPages: skipped } : {}),
  } satisfies ParsedDocument;
});
