import { Context, Effect, Layer } from "effect";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { DocumentParseError } from "../errors.ts";

export interface ParsedDocument {
  text: string;
  /** Parser kind the text came from; cached alongside it to invalidate later. */
  parsedWith: string;
  truncated: boolean;
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
        return yield* parseLocalPdf(input, row.config);
      });

      return DocumentParser.of({ parsePdf, availability });
    }),
  );
}

export const LOCAL_PARSER_KIND = "local";

const parseLocalPdf = Effect.fn("DocumentParser.parseLocalPdf")(function* (
  input: { bytes: Uint8Array; fileName: string },
  config: { maxChars: number; maxPages: number },
) {
  const pages = yield* Effect.tryPromise({
    try: async () => {
      // pdf.js is heavy and only needed when a non-native model meets a PDF.
      const { extractText, getDocumentProxy } = await import("unpdf");
      // pdf.js transfers (and detaches) the buffer it is given; copy so the
      // caller's bytes stay usable — the same blob may be sent natively too.
      const document = await getDocumentProxy(new Uint8Array(input.bytes));
      const { text } = await extractText(document);
      return text;
    },
    catch: (error) =>
      new DocumentParseError({
        fileName: input.fileName,
        reason: error instanceof Error ? error.message : "could not read the PDF",
      }),
  });

  const used = pages.slice(0, config.maxPages);
  const joined = used
    .map((page, index) => `[page ${index + 1}]\n${page.trim()}`)
    .join("\n\n")
    .trim();

  if (joined.replace(/\[page \d+\]/g, "").trim() === "") {
    return yield* new DocumentParseError({
      fileName: input.fileName,
      reason: "no extractable text (the PDF is probably a scan)",
    });
  }

  const truncated = joined.length > config.maxChars || pages.length > used.length;
  const text = joined.length > config.maxChars ? joined.slice(0, config.maxChars) : joined;
  return {
    text: truncated ? `${text}\n\n[document truncated]` : text,
    parsedWith: LOCAL_PARSER_KIND,
    truncated,
  } satisfies ParsedDocument;
});
