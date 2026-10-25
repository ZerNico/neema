import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { beforeEach, vi, type TestContext } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/pdf.ts";
import { buildScannedPdf } from "../../../../tests/fixtures/scanned-pdf.ts";
import { AnalyticsRepo, type UsageEventInput } from "~/modules/analytics/server/repo.ts";
import { OcrModels, type OcrModelStatus } from "~/modules/pdf/server/ocr-models.ts";
import { createPdfRuntime, PdfWorkers } from "~/modules/pdf/server/runtime.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { DocumentParserConfig } from "~/modules/tools/schema.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { assemble, DocumentParser, pdfFingerprint } from "./document-parser.ts";
import { AttachmentRepo } from "./repo.ts";

type Row = {
  enabled: boolean;
  config: DocumentParserConfig;
  secret: Redacted.Redacted<string> | null;
};

const row = (config: Partial<DocumentParserConfig> = {}, secret: string | null = null): Row => ({
  enabled: true,
  config: { maxChars: 100_000, maxPages: 100, scans: { mode: "off" }, ...config },
  secret: secret === null ? null : Redacted.make(secret),
});

/** The parser over a real PDF worker, with the stores and services around it faked. */
const harness = (
  context: Pick<TestContext, "signal" | "onTestFinished">,
  current: Row | null,
  files: OcrModelStatus = { state: "missing" },
) => {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const pending: Promise<unknown>[] = [];
  context.onTestFinished(async () => {
    controller.abort();
    await Promise.allSettled(pending);
  });
  const cache = new Map<string, { engine: string; pages: Record<number, string> }>();
  const usage: UsageEventInput[] = [];
  const workers = Layer.effect(
    PdfWorkers,
    Effect.acquireRelease(
      Effect.sync(() =>
        createPdfRuntime(new URL("../../pdf/server/runtime-worker.ts", import.meta.url)),
      ),
      (runtime) => Effect.promise(() => runtime.close()),
    ),
  );
  const layer = DocumentParser.base.pipe(
    Layer.provide([
      workers,
      Layer.succeed(
        ToolsRepo,
        ToolsRepo.of({
          getTool: () => Effect.die("unused"),
          getKnowledgeSearch: () => Effect.succeed(null),
          getWebSearch: () => Effect.succeed(null),
          getUrlReader: () => Effect.succeed(null),
          getDocumentParser: () => Effect.succeed(current),
          setToolEnabled: () => Effect.succeed({ tool: null, changed: false }),
          updateTool: () => Effect.succeed(null),
        }),
      ),
      Layer.succeed(
        OcrModels,
        OcrModels.of({
          status: () => Effect.succeed(files),
          ensure: () => Effect.void,
          paths: () => Effect.succeed(null),
        }),
      ),
      Layer.succeed(AttachmentRepo, {
        scannedPages: ({ blobId, engine }: { blobId: string; engine: string }) =>
          Effect.succeed(cache.get(blobId)?.engine === engine ? cache.get(blobId)!.pages : {}),
        saveScannedPages: (input: {
          blobId: string;
          engine: string;
          pages: Record<number, string>;
        }) =>
          Effect.sync(() => {
            const previous = cache.get(input.blobId);
            cache.set(input.blobId, {
              engine: input.engine,
              pages: {
                ...(previous?.engine === input.engine ? previous.pages : {}),
                ...input.pages,
              },
            });
          }),
      } as never),
      Layer.succeed(AnalyticsRepo, {
        record: (event: UsageEventInput) => Effect.sync(() => void usage.push(event)),
      } as never),
      // Only the vision-model reader uses these, and no test here chooses it.
      Layer.succeed(AiGateway, {} as never),
      Layer.succeed(ProviderRepo, {} as never),
      Layer.succeed(Db, {} as never),
    ]),
  );
  const run = <A, E>(f: (parser: DocumentParser["Service"]) => Effect.Effect<A, E>) => {
    const task = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* f(yield* DocumentParser);
        }).pipe(Effect.provide(layer)),
      ),
      { signal },
    );
    pending.push(task);
    return task;
  };
  return { run, cache, usage };
};

const mistralAnswers = (respond: (pages: number) => Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { document: { document_url: string } };
    const { PDFDocument } = await import("pdf-lib");
    const pdf = Buffer.from(body.document.document_url.split(",")[1]!, "base64");
    return respond((await PDFDocument.load(pdf)).getPageCount());
  });
const pagesResponse = (count: number, text: (index: number) => string) =>
  Response.json({
    pages: Array.from({ length: count }, (_, index) => ({ index, markdown: text(index) })),
    usage_info: { pages_processed: count },
  });

beforeEach((context) => {
  context.onTestFinished(() => {
    vi.restoreAllMocks();
  });
});

describe("DocumentParser availability", () => {
  it.for([
    ["missing", null, { configured: false, enabled: false, scanEngine: null }],
    ["off", row(), { configured: true, enabled: true, scanEngine: "off" }],
    [
      "Mistral's EU endpoint",
      row({ scans: { mode: "mistral", baseUrl: "https://api.eu.mistral.ai/v1" } }, "key"),
      {
        configured: true,
        enabled: true,
        scanEngine: "mistral-ocr-4-1@https://api.eu.mistral.ai/v1/ocr",
      },
    ],
  ] as const)("names the engine when %s", async ([_label, current, expected], context) => {
    expect(await harness(context, current).run((parser) => parser.availability())).toEqual(
      expected,
    );
  });
});

describe("Mistral endpoint identity", () => {
  it("normalizes equivalent endpoints and distinguishes scheme, port and path", async (context) => {
    const engine = (baseUrl: string) =>
      harness(context, row({ scans: { mode: "mistral", baseUrl } }, "key")).run((parser) =>
        Effect.map(parser.availability(), (availability) => availability.scanEngine),
      );
    const original = await engine("https://OCR.EXAMPLE:443/v1/");
    expect(original).toBe(await engine("https://ocr.example/v1"));
    for (const changed of [
      "http://ocr.example/v1",
      "https://ocr.example:8443/v1",
      "https://ocr.example/v2",
    ])
      expect(await engine(changed)).not.toBe(original);
  });

  it("does not reuse cached pages after changing a same-host endpoint", async (context) => {
    const fetch = mistralAnswers((count) => pagesResponse(count, () => "Read"));
    const current = row({ scans: { mode: "mistral", baseUrl: "https://ocr.example/v1" } }, "key");
    const { run } = harness(context, current);
    const bytes = await buildScannedPdf([{ kind: "scan", text: "One" }]);
    const parse = () =>
      run((parser) => parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob" }));
    const first = await parse();
    current.config = {
      ...current.config,
      scans: { mode: "mistral", baseUrl: "https://ocr.example/v2" },
    };
    const second = await parse();
    expect(second.parsedWith).not.toBe(first.parsedWith);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://ocr.example/v1/ocr",
      "https://ocr.example/v2/ocr",
    ]);
  });
});

describe("DocumentParser.parsePdf", () => {
  it("extracts page-labelled text, the same under any scan setting", async (context) => {
    const bytes = buildPdf(["First page body", "Second page body"]);
    const original = new Uint8Array(bytes);
    const parsed = await harness(context, row()).run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf" }),
    );
    expect(bytes).toEqual(original);
    expect(parsed).toEqual({
      text: "[page 1]\nFirst page body\n\n[page 2]\nSecond page body",
      parsedWith: pdfFingerprint(null),
      truncated: false,
      totalPages: 2,
      pageCount: 2,
    });
  });

  it.for([
    [{ maxPages: 1 }, ["First page", "Second page"], "page limit"],
    [{ maxChars: 10 }, ["A longer page of text"], "extraction limit"],
  ] as const)(
    "rejects incomplete knowledge extraction rather than truncating",
    async ([limits, pages, reason], context) => {
      const error = await harness(context, row(limits)).run((parser) =>
        Effect.flip(
          parser.parsePdf({ bytes: buildPdf(pages), fileName: "k.pdf", requireComplete: true }),
        ),
      );
      expect(error.reason).toContain(reason);
    },
  );

  it("truncates a prompt's PDF past its limits and says so", async (context) => {
    const parsed = await harness(context, row({ maxPages: 1 })).run((parser) =>
      parser.parsePdf({ bytes: buildPdf(["One", "Two"]), fileName: "a.pdf" }),
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toBe("[page 1]\nOne\n\n[document truncated]");
  });

  it("refuses while parsing is disabled, and bytes that are not a PDF", async (context) => {
    const disabled = await harness(context, { ...row(), enabled: false }).run((parser) =>
      Effect.flip(parser.parsePdf({ bytes: buildPdf(["x"]), fileName: "a.pdf" })),
    );
    expect(disabled.reason).toBe("document parsing is disabled");
    const garbage = await harness(context, row()).run((parser) =>
      Effect.flip(parser.parsePdf({ bytes: new TextEncoder().encode("hello"), fileName: "a.pdf" })),
    );
    expect(garbage.reason).toContain("could not read the PDF");
  });

  it("keeps scanned pages' markers and says why they were not read when reading is off", async (context) => {
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover letter" },
      { kind: "scan", text: "Signed contract" },
    ]);
    const parsed = await harness(context, row()).run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf" }),
    );
    expect(parsed.text).toBe(
      "[page 1]\nCover letter\n\n[page 2]\n(scanned page, not read: reading scanned pages is turned off)",
    );
    expect(parsed.skippedPages).toEqual([2]);
    // Off is a choice, complete for its setting, never retried.
    expect(parsed.parsedWith).toBe(pdfFingerprint("off"));
    expect(parsed.retryable).toBeUndefined();
  });

  it("refuses a wholly scanned PDF it cannot read, naming why", async (context) => {
    const bytes = await buildScannedPdf([{ kind: "scan", text: "Only a scan" }]);
    const error = await harness(
      context,
      row({ scans: { mode: "local", quality: "accurate" } }),
    ).run((parser) => Effect.flip(parser.parsePdf({ bytes, fileName: "a.pdf" })));
    expect(error.reason).toBe(
      "no extractable text: the PDF is scanned, and reading scanned pages is still being set up on this server",
    );
  });

  it("marks pages an unready engine skipped as incomplete, so they are read once it is ready", async (context) => {
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover" },
      { kind: "scan", text: "Scan" },
    ]);
    const parsed = await harness(context, row({ scans: { mode: "local", quality: "fast" } }), {
      state: "unsupported",
    }).run((parser) => parser.parsePdf({ bytes, fileName: "a.pdf" }));
    expect(parsed.parsedWith).toBe(pdfFingerprint("local-ppocrv6-tiny", true));
    expect(parsed.text).toContain(
      "not read: reading scanned pages is not available on this server",
    );
  });

  it("reads scans with Mistral once per blob, records the paid pages, and reuses them", async (context) => {
    const fetch = mistralAnswers((count) =>
      pagesResponse(count, (index) => `Scanned text ${index + 1}`),
    );
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover" },
      { kind: "scan", text: "Two" },
      { kind: "scan", text: "Three" },
    ]);
    const { run, usage } = harness(
      context,
      row({ scans: { mode: "mistral", baseUrl: "https://api.eu.mistral.ai/v1" } }, "secret"),
    );
    const progress: Array<[number, number]> = [];
    const parse = () =>
      run((parser) =>
        parser.parsePdf({
          bytes,
          fileName: "a.pdf",
          blobId: "blob-1",
          owner: "user-1",
          onScanProgress: (read, total) => Effect.sync(() => void progress.push([read, total])),
        }),
      );
    const first = await parse();
    expect(first.text).toBe(
      "[page 1]\nCover\n\n[page 2]\n(scanned page, read from its image)\nScanned text 1\n\n[page 3]\n(scanned page, read from its image)\nScanned text 2",
    );
    expect(first.parsedWith).toBe(
      pdfFingerprint("mistral-ocr-4-1@https://api.eu.mistral.ai/v1/ocr"),
    );
    expect(first.skippedPages).toBeUndefined();
    expect(progress).toEqual([
      [0, 2],
      [2, 2],
    ]);
    // Only the two scanned pages left the server, with the key, to the EU host.
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.eu.mistral.ai/v1/ocr");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    expect(usage).toMatchObject([{ userId: "user-1", kind: "ocr", modelName: "Mistral OCR" }]);
    // No price is assumed: list prices change, and other services charge their own.
    expect(usage[0]!.cost).toBeNull();

    const second = await parse();
    expect(second.text).toBe(first.text);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usage).toHaveLength(1);
  });

  it("leaves rate-limited pages unread and retryable, caching nothing", async (context) => {
    mistralAnswers(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover" },
      { kind: "scan", text: "Two" },
    ]);
    const { run, cache } = harness(
      context,
      row({ scans: { mode: "mistral", baseUrl: "https://api.mistral.ai/v1" } }, "secret"),
    );
    const parsed = await run((parser) =>
      parser.parsePdf({ bytes, fileName: "a.pdf", blobId: "blob-2" }),
    );
    expect(parsed.retryable).toEqual({ afterMs: 30_000 });
    expect(parsed.skippedPages).toEqual([2]);
    expect(parsed.parsedWith).toBe(
      pdfFingerprint("mistral-ocr-4-1@https://api.mistral.ai/v1/ocr", true),
    );
    expect(parsed.text).toContain(
      "not read: The OCR service is rate limiting (HTTP 429): slow down",
    );
    expect(cache.size).toBe(0);
  });

  it("does not publish cache pages or usage from an oversized Mistral response", async (context) => {
    mistralAnswers(
      () =>
        new Response("not read", {
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    );
    const bytes = await buildScannedPdf([
      { kind: "text", text: "Cover" },
      { kind: "scan", text: "Two" },
    ]);
    const { run, cache, usage } = harness(
      context,
      row({ scans: { mode: "mistral", baseUrl: "https://ocr.example/v1" } }, "secret"),
    );
    const parsed = await run((parser) =>
      parser.parsePdf({
        bytes,
        fileName: "a.pdf",
        blobId: "oversized",
        owner: "owner",
      }),
    );
    expect(parsed.skippedPages).toEqual([2]);
    expect(parsed.parsedWith).toContain("+incomplete");
    expect(parsed.text).toContain("response exceeded the byte limit");
    expect(cache.size).toBe(0);
    expect(usage).toEqual([]);
  });

  it("keeps a wholly scanned PDF retryable when its reader is rate limited", async (context) => {
    mistralAnswers(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }),
    );
    const bytes = await buildScannedPdf([{ kind: "scan", text: "Only page" }]);
    const error = await harness(
      context,
      row({ scans: { mode: "mistral", baseUrl: "https://api.eu.mistral.ai/v1" } }, "k"),
    ).run((parser) => Effect.flip(parser.parsePdf({ bytes, fileName: "scan.pdf" })));
    expect(error.retryable).toEqual({ afterMs: 5_000 });
  });

  it("cancels a test’s parse before reading scans and finishes its progress without publishing", async (context) => {
    const fetch = mistralAnswers((count) => pagesResponse(count, () => "Never read"));
    const controller = new AbortController();
    const { run, cache, usage } = harness(
      {
        signal: AbortSignal.any([context.signal, controller.signal]),
        onTestFinished: context.onTestFinished,
      },
      row({ scans: { mode: "mistral", baseUrl: "https://ocr.example/v1" } }, "fake-key"),
    );
    const bytes = await buildScannedPdf([{ kind: "scan", text: "Cancelled" }]);
    const progress: Array<[number, number]> = [];
    const parse = run((parser) =>
      parser.parsePdf({
        bytes,
        fileName: "a.pdf",
        blobId: "cancelled",
        owner: "owner",
        onScanProgress: (read, total) =>
          Effect.sync(() => {
            progress.push([read, total]);
            if (read < total) controller.abort();
          }),
      }),
    );
    await expect(parse).rejects.toThrow("All fibers interrupted without error");
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
    expect(usage).toEqual([]);
  });

  it("stops reading scans once the text passes the limit, so no page is paid for to be cut", async (context) => {
    const fetch = mistralAnswers((count) => pagesResponse(count, () => "x".repeat(400)));
    const bytes = await buildScannedPdf(
      Array.from({ length: 6 }, (_, i) => ({ kind: "scan" as const, text: `Page ${i + 1}` })),
    );
    const parse = (requireComplete: boolean) =>
      harness(
        context,
        row(
          { maxChars: 1000, scans: { mode: "mistral", baseUrl: "https://api.eu.mistral.ai/v1" } },
          "k",
        ),
      ).run((parser) =>
        Effect.result(parser.parsePdf({ bytes, fileName: "big.pdf", requireComplete })),
      );
    const chat = await parse(false);
    // One batch of four was enough to pass the limit; pages five and six were never sent.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chat._tag === "Success" && chat.success).toMatchObject({
      truncated: true,
      pageCount: 4,
    });
    const knowledge = await parse(true);
    expect(knowledge._tag === "Failure" && knowledge.failure.reason).toContain(
      "character extraction limit",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a complete extraction before reading scans when its text alone overflows", async (context) => {
    const fetch = mistralAnswers((count) => pagesResponse(count, () => "read"));
    const bytes = await buildScannedPdf([
      { kind: "text", text: "a".repeat(60) },
      { kind: "text", text: "b".repeat(60) },
      { kind: "scan", text: "Never sent" },
    ]);
    const error = await harness(
      context,
      row(
        { maxChars: 1000, scans: { mode: "mistral", baseUrl: "https://api.eu.mistral.ai/v1" } },
        "k",
      ),
    ).run((parser) =>
      Effect.flip(
        parser.parsePdf({
          bytes,
          fileName: "k.pdf",
          requireComplete: true,
          limits: { maxChars: 70, maxPages: 10 },
        }),
      ),
    );
    expect(error.reason).toContain("character extraction limit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an unread scan's own text layer, such as a slide title over a full-bleed image", async (context) => {
    const bytes = await buildScannedPdf([
      { kind: "scan", text: "Background", stamp: "Quarterly results" },
    ]);
    const parsed = await harness(context, row()).run((parser) =>
      parser.parsePdf({ bytes, fileName: "deck.pdf" }),
    );
    expect(parsed.text).toBe(
      "[page 1]\n(scanned page, not read: reading scanned pages is turned off)\nQuarterly results",
    );
  });

  it("reads only as many scanned pages as the caller allows", async (context) => {
    const fetch = mistralAnswers((count) => pagesResponse(count, () => "Read"));
    const bytes = await buildScannedPdf([
      { kind: "scan", text: "One" },
      { kind: "scan", text: "Two" },
    ]);
    const parsed = await harness(
      context,
      row({ scans: { mode: "mistral", baseUrl: "https://api.mistral.ai/v1" } }, "k"),
    ).run((parser) => parser.parsePdf({ bytes, fileName: "web.pdf", maxScanPages: 1 }));
    expect(parsed.text).toContain(
      "[page 2]\n(scanned page, not read: only the first scanned pages are read here)",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("assemble", () => {
  it("keeps every marker exactly `[page N]` and counts readable pages", () => {
    const { text, readable } = assemble(
      [
        { kind: "text", text: "Body" },
        { kind: "blank", text: "" },
        { kind: "scan", text: "" },
      ],
      new Map([[3, "Read text"]]),
      new Map(),
    );
    expect(text).toBe(
      "[page 1]\nBody\n\n[page 2]\n\n[page 3]\n(scanned page, read from its image)\nRead text",
    );
    expect(readable).toBe(2);
  });
});
