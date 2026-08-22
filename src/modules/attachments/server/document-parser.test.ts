import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { buildEmptyPdf, buildPdf } from "../../../../tests/fixtures/pdf.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { DocumentParser, LOCAL_PARSER_KIND } from "./document-parser.ts";

const repoLayer = (
  row: { enabled: boolean; kind: string; config: { maxChars: number; maxPages: number } } | null,
) =>
  Layer.succeed(
    ToolsRepo,
    ToolsRepo.of({
      getTool: () => Effect.succeed(null),
      getWebSearch: () => Effect.succeed(null),
      getDocumentParser: () => Effect.succeed(row),
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
  it("extracts page-labelled text", async () => {
    const parsed = await withParser(enabled(), (parser) =>
      parser.parsePdf({
        bytes: buildPdf(["First page body", "Second page body"]),
        fileName: "a.pdf",
      }),
    );
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
