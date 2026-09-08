import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { vi } from "vitest";
import * as unpdf from "unpdf";

vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("unpdf")>();
  return { ...actual, getResolvedPDFJS: vi.fn(actual.getResolvedPDFJS) };
});
import { buildEmptyPdf, buildPdf } from "../../../../tests/fixtures/pdf.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { DocumentParser, LOCAL_PARSER_KIND, stripControlCharacters } from "./document-parser.ts";

const repoLayer = (
  row: { enabled: boolean; kind: string; config: { maxChars: number; maxPages: number } } | null,
) =>
  Layer.succeed(
    ToolsRepo,
    ToolsRepo.of({
      getTool: () => Effect.succeed(null),
      getKnowledgeSearch: () => Effect.succeed(null),
      getWebSearch: () => Effect.succeed(null),
      getUrlReader: () => Effect.succeed(null),
      getDocumentParser: () => Effect.succeed(row),
      setToolEnabled: () => Effect.succeed({ tool: null, changed: false }),
      updateTool: () => Effect.succeed(null),
    }),
  );

const enabled = (config: Partial<{ maxChars: number; maxPages: number }> = {}) =>
  repoLayer({
    enabled: true,
    kind: LOCAL_PARSER_KIND,
    config: { maxChars: 100_000, maxPages: 100, ...config },
  });

const withParser = <A, E>(
  layer: Layer.Layer<ToolsRepo>,
  f: (parser: DocumentParser["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* DocumentParser);
    }).pipe(Effect.provide(DocumentParser.layer.pipe(Layer.provide(layer)))),
  );

const parseError = (layer: Layer.Layer<ToolsRepo>, bytes: Uint8Array, fileName = "doc.pdf") =>
  withParser(layer, (parser) => Effect.flip(parser.parsePdf({ bytes, fileName })));

describe("DocumentParser availability", () => {
  it.each([
    ["missing", null, { configured: false, enabled: false, kind: null }],
    [
      "disabled",
      { enabled: false, kind: LOCAL_PARSER_KIND, config: { maxChars: 10, maxPages: 1 } },
      { configured: true, enabled: false, kind: LOCAL_PARSER_KIND },
    ],
  ])("reports the registry row as %s", async (_label, row, expected) => {
    const availability = await withParser(repoLayer(row), (parser) => parser.availability());
    expect(availability).toEqual(expected);
  });
});

describe("DocumentParser.parsePdf (local backend)", () => {
  it.each([
    [{ maxPages: 1 }, ["First page", "Second page"], "page limit"],
    [{ maxChars: 10 }, ["A longer page of text"], "extraction limit"],
  ])(
    "rejects incomplete knowledge extraction rather than truncating",
    async (limits, pages, reason) => {
      const error = await withParser(enabled(limits), (parser) =>
        Effect.flip(
          parser.parsePdf({
            bytes: buildPdf(pages),
            fileName: "knowledge.pdf",
            requireComplete: true,
          }),
        ),
      );
      expect(error.reason).toContain(reason);
    },
  );

  it("extracts page-labelled text", async () => {
    const bytes = buildPdf(["First page body", "Second page body"]);
    const original = new Uint8Array(bytes);
    const parsed = await withParser(enabled(), (parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf" }),
    );
    expect(bytes).toEqual(original);
    expect(parsed).toEqual({
      text: "[page 1]\nFirst page body\n\n[page 2]\nSecond page body",
      parsedWith: LOCAL_PARSER_KIND,
      truncated: false,
    });
  });

  it("truncates past maxChars and says so", async () => {
    const parsed = await withParser(enabled({ maxChars: 20 }), (parser) =>
      parser.parsePdf({ bytes: buildPdf(["A fairly long line of text"]), fileName: "a.pdf" }),
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toBe("[page 1]\nA fairly lo\n\n[document truncated]");
  });

  it("stops after maxPages", async () => {
    const parsed = await withParser(enabled({ maxPages: 1 }), (parser) =>
      parser.parsePdf({ bytes: buildPdf(["Kept page", "Dropped page"]), fileName: "a.pdf" }),
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toBe("[page 1]\nKept page\n\n[document truncated]");
  });

  it("never requests excluded pages and releases the document after extracting text", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const getTextContent = vi.fn().mockResolvedValue({
      items: [
        { str: "First", hasEOL: true },
        { type: "beginMarkedContent" },
        { str: "Second", hasEOL: false },
      ],
    });
    const getPage = vi.fn(async (page: number) => {
      if (page > 1) throw new Error("excluded page must not be extracted");
      return { getTextContent, cleanup: vi.fn() };
    });
    vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({
      getDocument: () => ({ promise: Promise.resolve({ numPages: 3, getPage }), destroy }),
    } as never);

    const parsed = await withParser(enabled({ maxPages: 1 }), (parser) =>
      parser.parsePdf({ bytes: new Uint8Array(), fileName: "limited.pdf" }),
    );
    expect(parsed.text).toBe("[page 1]\nFirst\nSecond\n\n[document truncated]");
    expect(parsed.truncated).toBe(true);
    expect(getPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the document when a retained page fails extraction", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: vi.fn().mockRejectedValue(new Error("broken page")),
          }),
        }),
        destroy,
      }),
    } as never);

    const error = await parseError(enabled(), new Uint8Array(), "broken.pdf");
    expect(error).toMatchObject({ reason: "broken page", fileName: "broken.pdf" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a PDF worker when extraction is interrupted", async () => {
    const started = Deferred.makeUnsafe<void>();
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: vi.fn().mockResolvedValue({
            getTextContent: () => {
              Effect.runSync(Deferred.succeed(started, undefined));
              return new Promise(() => {});
            },
          }),
        }),
        destroy,
      }),
    } as never);
    const fiber = Effect.runFork(
      Effect.flatMap(DocumentParser, (parser) =>
        parser.parsePdf({
          bytes: new Uint8Array(),
          fileName: "stalled.pdf",
          requireComplete: true,
        }),
      ).pipe(Effect.provide(DocumentParser.layer.pipe(Layer.provide(enabled())))),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "destroys pending PDF acquisition on interruption (requireComplete=%s)",
    async (requireComplete) => {
      const started = Deferred.makeUnsafe<void>();
      let rejectLoading!: (error: Error) => void;
      const promise = new Promise<never>((_resolve, reject) => {
        rejectLoading = reject;
      });
      const destroy = vi.fn(async () => {
        rejectLoading(new Error("loading task destroyed"));
      });
      vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({
        getDocument: () => {
          Effect.runSync(Deferred.succeed(started, undefined));
          return { promise, destroy };
        },
      } as never);
      const fiber = Effect.runFork(
        Effect.flatMap(DocumentParser, (parser) =>
          parser.parsePdf({ bytes: new Uint8Array(), fileName: "loading.pdf", requireComplete }),
        ).pipe(Effect.provide(DocumentParser.layer.pipe(Layer.provide(enabled())))),
      );
      await Effect.runPromise(Deferred.await(started));
      await Effect.runPromise(Fiber.interrupt(fiber));
      // Let the rejected acquisition settle through finally as well as abort:
      // both paths must share one destruction, without an unhandled rejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("does not start PDF loading if interrupted while resolving PDF.js", async () => {
    const started = Deferred.makeUnsafe<void>();
    const getDocument = vi.fn();
    let resolveModule!: (module: Awaited<ReturnType<typeof unpdf.getResolvedPDFJS>>) => void;
    vi.mocked(unpdf.getResolvedPDFJS).mockImplementationOnce(() => {
      Effect.runSync(Deferred.succeed(started, undefined));
      return new Promise((resolve) => {
        resolveModule = resolve;
      });
    });
    const fiber = Effect.runFork(
      Effect.flatMap(DocumentParser, (parser) =>
        parser.parsePdf({ bytes: new Uint8Array(), fileName: "cancelled.pdf" }),
      ).pipe(Effect.provide(DocumentParser.layer.pipe(Layer.provide(enabled())))),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));
    resolveModule({ getDocument } as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("destroys the loading task when document acquisition fails", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({
      getDocument: () => ({ promise: Promise.reject(new Error("broken PDF load")), destroy }),
    } as never);
    const error = await parseError(enabled(), new Uint8Array(), "broken.pdf");
    expect(error).toMatchObject({ reason: "broken PDF load", fileName: "broken.pdf" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("extracts a complete PDF using caller limits instead of prompt limits", async () => {
    const parsed = await withParser(enabled({ maxPages: 1, maxChars: 10 }), (parser) =>
      parser.parsePdf({
        bytes: buildPdf(["First page body", "Second page body"]),
        fileName: "knowledge.pdf",
        limits: { maxPages: 2, maxChars: 1_000 },
        requireComplete: true,
      }),
    );
    expect(parsed).toEqual({
      text: "[page 1]\nFirst page body\n\n[page 2]\nSecond page body",
      parsedWith: LOCAL_PARSER_KIND,
      truncated: false,
    });
  });

  it("skips a textless page, keeps its marker, and reports it instead of refusing the file", async () => {
    const parsed = await withParser(enabled(), (parser) =>
      parser.parsePdf({
        bytes: buildPdf(["Readable introduction", "", "Readable conclusion"]),
        fileName: "mixed.pdf",
        requireComplete: true,
      }),
    );
    // Page numbers stay aligned with the original: the marker survives alone.
    expect(parsed.text).toBe(
      "[page 1]\nReadable introduction\n\n[page 2]\n\n[page 3]\nReadable conclusion",
    );
    expect(parsed.truncated).toBe(false);
    expect(parsed.skippedPages).toEqual([2]);
  });

  it("strips NUL and other control characters that pdf.js emits for private-use glyphs", () => {
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    expect(stripControlCharacters(`Ticket ${nul}${bell} QR\tcode\nnext\r\nline`)).toBe(
      "Ticket  QR\tcode\nnext\r\nline",
    );
  });

  it("rejects a PDF with no extractable text", async () => {
    const error = await parseError(enabled(), buildEmptyPdf(), "scan.pdf");
    expect(error).toMatchObject({ _tag: "DocumentParseError", fileName: "scan.pdf" });
    expect(error.reason).toContain("no extractable text");
  });

  it("rejects bytes that are not a PDF at all", async () => {
    const error = await parseError(enabled(), new TextEncoder().encode("not a pdf"));
    expect(error._tag).toBe("DocumentParseError");
  });

  it("refuses to parse while the registry row is disabled or unknown", async () => {
    const pdf = buildPdf(["body"]);
    const off = await parseError(
      repoLayer({ enabled: false, kind: LOCAL_PARSER_KIND, config: { maxChars: 10, maxPages: 1 } }),
      pdf,
    );
    expect(off.reason).toBe("document parsing is disabled");

    const alien = await parseError(
      repoLayer({ enabled: true, kind: "cloud-ocr", config: { maxChars: 10, maxPages: 1 } }),
      pdf,
    );
    expect(alien.reason).toContain("cloud-ocr");
  });
});
