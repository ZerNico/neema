import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Semaphore } from "effect";
import { models, providers } from "~/db/schema/index.ts";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { PDF_RASTER } from "~/modules/pdf/limits.ts";
import { OcrModels, ocrVariantId } from "~/modules/pdf/server/ocr-models.ts";
import { PdfWorkers } from "~/modules/pdf/server/runtime.ts";
import {
  localReader,
  MISTRAL_OCR_MODEL,
  mistralReader,
  mistralEndpoint,
  modelReader,
  type ScanFailure,
  type ScanReader,
} from "~/modules/pdf/server/scan-readers.ts";
import type { PageKind } from "~/modules/pdf/classify.ts";
import { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ScanModelConnection, ScanReading } from "~/modules/tools/schema.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { DocumentParseError } from "../errors.ts";
import { AttachmentRepo } from "./repo.ts";

export { stripControlCharacters } from "~/modules/pdf/classify.ts";

export interface ParsedDocument {
  /** `[page N]` blocks; a scanned page says so on the line after its marker. */
  text: string;
  /** What produced the text; see `pdfFingerprint`. Cached beside it to invalidate later. */
  parsedWith: string;
  truncated: boolean;
  /** Pages in the file, and how many of them the text covers. */
  totalPages: number;
  pageCount: number;
  /** 1-based scanned pages whose text is not in `text`. Present only when some are. */
  skippedPages?: ReadonlyArray<number>;
  /** Some scanned pages failed in a way worth trying again later (an outage, a rate limit). */
  retryable?: { readonly afterMs?: number };
}

export interface DocumentParserAvailability {
  configured: boolean;
  enabled: boolean;
  /** The fingerprint a PDF with scans gets under the current settings. */
  scanEngine: string | null;
}

/** Bump whenever PDF extraction semantics change. */
export const PDF_EXTRACTION_REVISION = 3;
const TEXT_ONLY = `pdf-${PDF_EXTRACTION_REVISION}`;

/**
 * The fingerprint of an extraction: a PDF with no scanned pages does not
 * depend on how scans are read, so it stays current under any setting; one
 * with scans names the engine, and `+incomplete` when pages failed, which no
 * setting ever matches, so a rebuild reads them again.
 */
export const pdfFingerprint = (scanEngine: string | null, incomplete = false) =>
  scanEngine === null
    ? TEXT_ONLY
    : `${TEXT_ONLY}+scan:${scanEngine}${incomplete ? "+incomplete" : ""}`;

/** Every fingerprint a current PDF extraction can carry under these settings. */
export const currentPdfFingerprints = (availability: DocumentParserAvailability) => [
  TEXT_ONLY,
  ...(availability.scanEngine ? [pdfFingerprint(availability.scanEngine)] : []),
];

type Engine =
  | { readonly id: string; readonly reader: ScanReader }
  | { readonly id: string; readonly unavailable: string };

export interface ParsePdfInput {
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
  /** Whose action this is: their queue in the workers, and who a paid reading is billed to. */
  owner?: string;
  /** The stored blob, so its scanned pages are read once and reused by every later reader. */
  blobId?: string;
  /** At most this many scanned pages are read; the rest are reported unread. */
  maxScanPages?: number;
  /** Work nobody waits on, such as indexing: it queues behind chat reads in the workers. */
  background?: boolean;
  /** Called as scanned pages are read, for a progress line. */
  onScanProgress?: (read: number, total: number) => Effect.Effect<void>;
}

/**
 * The connection a vision model has now, or null when it may not be sent
 * scanned pages: disabled, not public, not a vision model, or gone.
 */
export const readVisionConnection = (db: Db["Service"], modelId: string) =>
  Effect.gen(function* () {
    const [row] = yield* db
      .select({
        providerId: providers.id,
        baseUrl: providers.baseUrl,
        modelKey: models.modelKey,
        capabilities: models.capabilities,
        enabled: models.enabled,
        providerEnabled: providers.enabled,
        access: models.access,
        type: models.type,
      })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(eq(models.id, modelId))
      .pipe(Effect.orDie);
    if (
      !row?.enabled ||
      !row.providerEnabled ||
      row.type !== "chat" ||
      row.access !== "public" ||
      !row.capabilities.vision
    )
      return null;
    return {
      providerId: row.providerId,
      baseUrl: row.baseUrl.replace(/\/$/, ""),
      modelKey: row.modelKey,
    } satisfies ScanModelConnection;
  });

/**
 * Extracts text from PDFs for models that cannot read them natively and for
 * search. The text layer is read locally; pages without one (scans) are read
 * by the engine an admin chose, possibly a service outside this server.
 */
export class DocumentParser extends Context.Service<
  DocumentParser,
  {
    parsePdf(input: ParsePdfInput): Effect.Effect<ParsedDocument, DocumentParseError>;
    availability(): Effect.Effect<DocumentParserAvailability>;
  }
>()("chat/attachments/DocumentParser") {
  /** The parser over whatever workers, model files and gateway it is given; tests supply their own. */
  static readonly base = Layer.effect(
    DocumentParser,
    Effect.gen(function* () {
      const repo = yield* ToolsRepo;
      const workers = yield* PdfWorkers;
      const ocrModels = yield* OcrModels;
      const attachments = yield* AttachmentRepo;
      const analytics = yield* AnalyticsRepo;
      const gateway = yield* AiGateway;
      const providerRepo = yield* ProviderRepo;
      const db = yield* Db;

      // A server restarted with local reading on fetches files it lost.
      const initial = yield* repo.getDocumentParser();
      if (initial?.enabled && initial.config.scans?.mode === "local")
        yield* ocrModels.ensure(initial.config.scans.quality);

      /** The engine the settings name, resolved now: a parse keeps this snapshot throughout. */
      const resolveEngine = Effect.fn("DocumentParser.resolveEngine")(function* (
        scans: ScanReading,
        secret: Parameters<typeof mistralReader>[0]["key"] | null,
      ) {
        switch (scans.mode) {
          case "off":
            return null;
          case "local": {
            const id = `local-${ocrVariantId(scans.quality)}`;
            const paths = yield* ocrModels.paths(scans.quality);
            if (paths) return { id, reader: localReader(workers, paths) } satisfies Engine;
            const status = yield* ocrModels.status(scans.quality);
            return {
              id,
              unavailable:
                status.state === "unsupported"
                  ? "reading scanned pages is not available on this server"
                  : "reading scanned pages is still being set up on this server",
            } satisfies Engine;
          }
          case "mistral": {
            // The endpoint is part of the identity: another service may read differently.
            const id = `${MISTRAL_OCR_MODEL}@${mistralEndpoint(scans.baseUrl)}`;
            if (!secret)
              return { id, unavailable: "no Mistral key is configured" } satisfies Engine;
            return {
              id,
              reader: mistralReader({ workers, analytics, baseUrl: scans.baseUrl, key: secret }),
            } satisfies Engine;
          }
          case "model": {
            // The connection is part of the identity: re-approving a changed one re-reads.
            const id = `model:${scans.modelId}:${createHash("sha256")
              .update(
                `${scans.approved.providerId}\n${scans.approved.baseUrl}\n${scans.approved.modelKey}`,
              )
              .digest("hex")
              .slice(0, 12)}`;
            const now = yield* readVisionConnection(db, scans.modelId);
            const approved =
              now !== null &&
              now.providerId === scans.approved.providerId &&
              now.baseUrl === scans.approved.baseUrl &&
              now.modelKey === scans.approved.modelKey;
            if (!approved)
              return {
                id,
                unavailable:
                  "the model chosen for reading scanned pages needs an admin’s approval again",
              } satisfies Engine;
            return {
              id,
              reader: modelReader({
                workers,
                gateway,
                providers: providerRepo,
                analytics,
                modelId: scans.modelId,
                approved: scans.approved,
              }),
            } satisfies Engine;
          }
        }
      });

      const availability = Effect.fn("DocumentParser.availability")(function* () {
        const row = yield* repo.getDocumentParser();
        const scans = row?.config.scans ?? { mode: "off" as const };
        const engine = row ? yield* resolveEngine(scans, row.secret) : null;
        return {
          configured: row !== null,
          enabled: row?.enabled ?? false,
          scanEngine: row ? (engine?.id ?? "off") : null,
        } satisfies DocumentParserAvailability;
      });

      // One reader per blob and engine at a time: a second caller waits, then
      // finds the pages the first one read in the cache.
      const locks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();
      const exclusive = <A, E, R>(key: string | null, work: Effect.Effect<A, E, R>) => {
        if (key === null) return work;
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
            entry.users++;
            locks.set(key, entry);
            return entry;
          }),
          (entry) => entry.lock.withPermits(1)(work),
          (entry) =>
            Effect.sync(() => {
              if (--entry.users === 0) locks.delete(key);
            }),
        );
      };

      const parsePdf = Effect.fn("DocumentParser.parsePdf")(function* (input: ParsePdfInput) {
        const fail = (reason: string) =>
          new DocumentParseError({ fileName: input.fileName, reason });
        const row = yield* repo.getDocumentParser();
        if (!row || !row.enabled) return yield* fail("document parsing is disabled");
        const limits = input.limits ?? row.config;
        const scans = row.config.scans ?? { mode: "off" as const };
        const runOptions = {
          ...(input.owner ? { owner: input.owner } : {}),
          ...(input.background ? { priority: "background" as const } : {}),
        };

        const read = yield* Effect.tryPromise({
          try: (signal) =>
            workers.run(
              {
                kind: "read",
                bytes: input.bytes,
                maxPages: limits.maxPages,
                maxChars: limits.maxChars,
                ...(input.requireComplete ? { requireComplete: true } : {}),
              },
              signal,
              runOptions,
            ),
          catch: (error) => fail(error instanceof Error ? error.message : "could not read the PDF"),
        });
        if (input.requireComplete && read.totalPages > limits.maxPages)
          return yield* fail(
            `PDF exceeds the ${limits.maxPages}-page limit; split it into smaller documents`,
          );
        const charLimit = () =>
          fail(
            `PDF exceeds the ${limits.maxChars}-character extraction limit; split it into smaller documents`,
          );
        // The text layer alone already overflows: refuse before paying to read any scan.
        if (input.requireComplete && read.totalPages > read.pages.length) return yield* charLimit();

        const scanned = read.pages.flatMap((page, index) =>
          page.kind === "scan" ? [index + 1] : [],
        );
        const texts = new Map<number, string>();
        const unread = new Map<number, string>();
        let retryable: ParsedDocument["retryable"];
        let engineId: string | null = null;
        // The last page kept once the text passes the character limit; nothing after it is read.
        let cutAfter: number | null = null;
        if (scanned.length > 0) {
          const engine = yield* resolveEngine(scans, row.secret);
          engineId = engine?.id ?? "off";
          const wanted = scanned.slice(0, input.maxScanPages ?? scanned.length);
          for (const page of scanned.slice(wanted.length))
            unread.set(page, "only the first scanned pages are read here");
          if (!engine)
            for (const page of wanted) unread.set(page, "reading scanned pages is turned off");
          else if ("unavailable" in engine)
            for (const page of wanted) unread.set(page, engine.unavailable);
          else {
            const reader = engine.reader;
            const cacheKey = input.blobId ? `${input.blobId}\n${engine.id}` : null;
            yield* exclusive(
              cacheKey,
              Effect.gen(function* () {
                const cached = input.blobId
                  ? yield* attachments.scannedPages({ blobId: input.blobId, engine: engine.id })
                  : {};
                const pending = wanted.filter((page) => {
                  const text = cached[page];
                  if (text !== undefined) texts.set(page, text);
                  return text === undefined;
                });
                let done = wanted.length - pending.length;
                if (input.onScanProgress && pending.length > 0)
                  yield* input.onScanProgress(done, wanted.length);
                for (let start = 0; start < pending.length; start += PDF_RASTER.pagesPerJob) {
                  const batch = pending.slice(start, start + PDF_RASTER.pagesPerJob);
                  const result = yield* reader({
                    bytes: input.bytes,
                    pages: batch,
                    runOptions,
                  });
                  // Pages read before a failure are kept, paid for as they were.
                  for (const page of result.pages) texts.set(page.page, page.text);
                  if (input.blobId && result.pages.length > 0)
                    yield* attachments.saveScannedPages({
                      blobId: input.blobId,
                      engine: engine.id,
                      pages: Object.fromEntries(result.pages.map((page) => [page.page, page.text])),
                    });
                  if (!result.ok) {
                    for (const page of pending.slice(start))
                      if (!texts.has(page)) unread.set(page, result.failure.reason);
                    retryable = transientOf(result.failure);
                    break;
                  }
                  done += batch.length;
                  // Scans add text the worker could not count: stop at the limit, not after it.
                  const through = batch.at(-1)!;
                  if (
                    assemble(read.pages.slice(0, through), texts, unread).text.length >
                    limits.maxChars
                  ) {
                    cutAfter = through;
                    break;
                  }
                  if (input.onScanProgress && done < wanted.length)
                    yield* input.onScanProgress(done, wanted.length);
                }
              }).pipe(
                // Finished however it ends, so no "reading" line outlives the reading.
                Effect.ensuring(
                  input.onScanProgress
                    ? input.onScanProgress(wanted.length, wanted.length)
                    : Effect.void,
                ),
              ),
            );
          }
        }

        if (cutAfter !== null && input.requireComplete) return yield* charLimit();
        const kept = cutAfter === null ? read.pages : read.pages.slice(0, cutAfter);
        for (const page of unread.keys()) if (page > kept.length) unread.delete(page);
        const assembled = assemble(kept, texts, unread);
        if (assembled.readable === 0)
          return yield* new DocumentParseError({
            fileName: input.fileName,
            reason:
              scanned.length === 0
                ? "no extractable text"
                : `no extractable text: the PDF is scanned, and ${unread.values().next().value ?? "its pages could not be read"}`,
            ...(retryable ? { retryable } : {}),
          });
        const truncated = assembled.text.length > limits.maxChars || read.totalPages > kept.length;
        if (truncated && input.requireComplete) return yield* charLimit();
        const text =
          assembled.text.length > limits.maxChars
            ? assembled.text.slice(0, limits.maxChars)
            : assembled.text;
        // Off is a choice, complete for its setting; any other unread page failed.
        const failed = engineId !== null && engineId !== "off" && unread.size > 0;
        return {
          text: truncated ? `${text}\n\n[document truncated]` : text,
          parsedWith: pdfFingerprint(engineId, failed),
          truncated,
          totalPages: read.totalPages,
          pageCount: kept.length,
          ...(unread.size > 0
            ? { skippedPages: [...unread.keys()].toSorted((a, b) => a - b) }
            : {}),
          ...(retryable ? { retryable } : {}),
        } satisfies ParsedDocument;
      });

      return DocumentParser.of({ parsePdf, availability });
    }),
  );

  static readonly layer = DocumentParser.base.pipe(
    Layer.provide([PdfWorkers.layer, AiGateway.layer]),
    // Merged: the admin page reads and starts the model files directly.
    Layer.provideMerge(OcrModels.layer),
  );
}

const transientOf = (failure: ScanFailure): ParsedDocument["retryable"] =>
  failure.transient
    ? failure.retryAfterMs === undefined
      ? {}
      : { afterMs: failure.retryAfterMs }
    : undefined;

/**
 * Pages as `[page N]` blocks. The marker line stays exactly that, since
 * chunking and citations key on it; a scanned page says so on the next line.
 */
export function assemble(
  pages: ReadonlyArray<{ text: string; kind: PageKind }>,
  scanTexts: ReadonlyMap<number, string>,
  unread: ReadonlyMap<number, string>,
) {
  let readable = 0;
  const blocks = pages.map((page, index) => {
    const number = index + 1;
    const marker = `[page ${number}]`;
    if (page.kind === "blank") return marker;
    if (page.kind === "text") {
      if (page.text) readable++;
      return `${marker}\n${page.text}`.trimEnd();
    }
    const reason = unread.get(number);
    // An unread page keeps whatever text layer it has, such as a slide's title.
    if (reason !== undefined) {
      if (page.text) readable++;
      return `${marker}\n(scanned page, not read: ${reason})${page.text ? `\n${page.text}` : ""}`;
    }
    const text = scanTexts.get(number) ?? "";
    if (text) readable++;
    return `${marker}\n(scanned page, read from its image)${text ? `\n${text}` : ""}`;
  });
  return { text: blocks.join("\n\n").trim(), readable };
}
