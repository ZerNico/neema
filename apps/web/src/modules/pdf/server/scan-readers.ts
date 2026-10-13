import { Effect, Option, Redacted, Schema } from "effect";
import { Prompt } from "effect/unstable/ai";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";
import type { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ScanModelConnection } from "~/modules/tools/schema.ts";
import { parseRetryAfter } from "~/server/retry-after.ts";
import { stripControlCharacters } from "../classify.ts";
import { PDF_RASTER, scanJobTimeoutMs } from "../limits.ts";
import type { OcrModelPaths } from "./ocr/engine.ts";
import type { PdfRuntime } from "./runtime.ts";

/**
 * Why a batch of scanned pages was not read. Transient failures (a rate
 * limit, an outage, a busy worker) are worth retrying later; the rest need an
 * admin, so retrying sooner only spends money.
 */
export interface ScanFailure {
  readonly reason: string;
  readonly transient: boolean;
  readonly retryAfterMs?: number;
}

type ReadPages = ReadonlyArray<{ page: number; text: string }>;
/** A failed batch still names the pages it read before failing: they were paid for. */
export type ScanBatchResult =
  | { readonly ok: true; readonly pages: ReadPages }
  | { readonly ok: false; readonly failure: ScanFailure; readonly pages: ReadPages };

/** Where a reader's worker jobs queue: whose they are, and whether anyone is waiting. */
export interface ScanRunOptions {
  readonly owner?: string;
  readonly priority?: "background";
}

/** Reads a few scanned pages of one PDF: the unit each engine is called with. */
export type ScanReader = (input: {
  readonly bytes: Uint8Array;
  readonly pages: readonly number[];
  readonly runOptions: ScanRunOptions;
}) => Effect.Effect<ScanBatchResult>;

/** Each page's text is bounded, so one hallucinating model cannot fill a document. */
const PAGE_TEXT_CHARS = 20_000;
const tidy = (text: string) => stripControlCharacters(text).trim().slice(0, PAGE_TEXT_CHARS);

const workerFailure = (error: unknown): ScanFailure => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "reading failed";
  return {
    reason: message,
    transient:
      code === "busy" || code === "timeout" || code === "worker_exit" || code === "cancelled",
  };
};

/** Recognition on this server, in the PDF worker. */
export const localReader =
  (workers: PdfRuntime, models: OcrModelPaths): ScanReader =>
  ({ bytes, pages, runOptions }) =>
    Effect.tryPromise({
      try: (signal) =>
        workers.run({ kind: "ocr", bytes, pages, models }, signal, {
          ...runOptions,
          timeoutMs: scanJobTimeoutMs(pages.length),
        }),
      catch: workerFailure,
    }).pipe(
      Effect.map((read): ScanBatchResult => ({
        ok: true,
        pages: read.map((page) => ({ page: page.page, text: tidy(page.text) })),
      })),
      Effect.catch((failure) => Effect.succeed<ScanBatchResult>({ ok: false, failure, pages: [] })),
    );

/** The pinned Mistral model: a newer one is a deliberate change, and part of the fingerprint. */
export const MISTRAL_OCR_MODEL = "mistral-ocr-4-1";
export const MISTRAL_DEFAULT_BASE_URL = "https://api.mistral.ai/v1";

/** A base URL as typed, normalised (blank is Mistral's own), or null when it is not an http(s) URL. */
export const mistralBaseUrl = (raw: string | undefined) => {
  try {
    const url = new URL(raw?.trim() || MISTRAL_DEFAULT_BASE_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};
export const mistralEndpoint = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ocr`;
  url.hash = "";
  return url.toString();
};
const MISTRAL_TIMEOUT_MS = 120_000;
const MISTRAL_RESPONSE_BYTES = 1024 * 1024;
const MISTRAL_ERROR_BYTES = 16 * 1024;
const MistralPages = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: PDF_RASTER.pagesPerJob - 1 }),
      ),
      // Allow Markdown overhead before the shared per-page publication cap.
      markdown: Schema.String.check(Schema.isMaxLength(PAGE_TEXT_CHARS * 4)),
    }),
  ).check(Schema.isMaxLength(PDF_RASTER.pagesPerJob)),
});
const MistralErrorDetail = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});

const mistralOverflow = {
  reason: "The OCR service response exceeded the byte limit",
  transient: false,
} satisfies ScanFailure;

/** Count decoded response bytes too: Content-Length may describe compressed bytes or be absent. */
export const readMistralBody = async (response: Response, maxBytes: number) => {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw mistralOverflow;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength === 0) continue;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw mistralOverflow;
      }
      parts.push(decoder.decode(part.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
};

const mistralFailure = (status: number, detail: string, retryAfter: string | null): ScanFailure => {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403)
    return {
      reason: `The OCR service rejected the key (HTTP ${status})${suffix}`,
      transient: false,
    };
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(retryAfter ?? undefined);
    return {
      reason: `The OCR service is rate limiting (HTTP 429)${suffix}`,
      transient: true,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    };
  }
  if (status === 408 || status >= 500)
    return { reason: `The OCR service is unavailable (HTTP ${status})${suffix}`, transient: true };
  return {
    reason: `The OCR service refused the pages (HTTP ${status})${suffix}`,
    transient: false,
  };
};

/**
 * One request to Mistral's OCR endpoint with the given PDF, its pages'
 * Markdown back by index. Shared by the reader and the admin's Test button.
 */
export const mistralOcr = (input: {
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
  readonly pdf: Uint8Array;
  readonly pageCount?: number;
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(mistralEndpoint(input.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(input.key)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MISTRAL_OCR_MODEL,
          document: {
            type: "document_url",
            document_url: `data:application/pdf;base64,${Buffer.from(input.pdf).toString("base64")}`,
          },
          include_image_base64: false,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(MISTRAL_TIMEOUT_MS)]),
      });
      const text = await readMistralBody(
        response,
        response.ok ? MISTRAL_RESPONSE_BYTES : MISTRAL_ERROR_BYTES,
      );
      if (!response.ok) {
        let detail = text;
        try {
          const body = Schema.decodeUnknownOption(MistralErrorDetail)(JSON.parse(text));
          if (Option.isSome(body)) detail = body.value.message ?? body.value.detail ?? text;
        } catch {
          // Not JSON; keep the text.
        }
        throw mistralFailure(
          response.status,
          detail.replace(/\s+/g, " ").trim().slice(0, 160),
          response.headers.get("retry-after"),
        );
      }
      const invalid = {
        reason: "The OCR service answered with something other than OCR results",
        transient: false,
      } satisfies ScanFailure;
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw invalid;
      }
      const body = Schema.decodeUnknownOption(MistralPages)(json);
      if (Option.isNone(body)) throw invalid;
      const pages = body.value.pages;
      const pageCount = input.pageCount ?? PDF_RASTER.pagesPerJob;
      if (
        pages.length > pageCount ||
        pages.some((page) => page.index >= pageCount) ||
        new Set(pages.map((page) => page.index)).size !== pages.length
      )
        throw invalid;
      return { pages };
    },
    catch: (error): ScanFailure =>
      error && typeof error === "object" && "transient" in error
        ? (error as ScanFailure)
        : {
            reason: `The OCR service could not be reached: ${error instanceof Error ? error.message : "network error"}`,
            transient: true,
          },
  });

/**
 * Mistral OCR on a PDF of just the scanned pages, so only those leave the
 * server; its pages come back by index in the order they were sent.
 */
export const mistralReader =
  (deps: {
    readonly workers: PdfRuntime;
    readonly analytics: AnalyticsRepo["Service"];
    readonly baseUrl: string;
    readonly key: Redacted.Redacted<string>;
  }): ScanReader =>
  ({ bytes, pages, runOptions }) =>
    Effect.gen(function* () {
      const pdf = yield* Effect.tryPromise({
        try: (signal) =>
          deps.workers.run({ kind: "subset", bytes, pages }, signal, {
            ...runOptions,
            timeoutMs: scanJobTimeoutMs(pages.length),
          }),
        catch: workerFailure,
      });
      const result = yield* mistralOcr({
        baseUrl: deps.baseUrl,
        key: deps.key,
        pdf,
        pageCount: pages.length,
      });
      const owner = runOptions.owner;
      // Recorded so readings show in analytics; a price written here would go stale, so the cost is unknown.
      if (owner)
        yield* deps.analytics.record({
          userId: owner,
          kind: "ocr",
          modelId: null,
          modelName: "Mistral OCR",
          status: "complete",
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          cost: null,
          costSource: null,
        });
      const byIndex = new Map(result.pages.map((page) => [page.index, page.markdown]));
      // A page Mistral did not return is unread, never silently empty.
      if (pages.some((_, index) => !byIndex.has(index)))
        return yield* Effect.fail<ScanFailure>({
          reason: "The OCR service returned fewer pages than it was sent",
          transient: true,
        });
      return {
        ok: true,
        pages: pages.map((page, index) => ({ page, text: tidy(byIndex.get(index)!) })),
      } satisfies ScanBatchResult;
    }).pipe(
      Effect.catch((failure) => Effect.succeed<ScanBatchResult>({ ok: false, failure, pages: [] })),
    );

const TRANSCRIBE =
  "Transcribe this scanned page exactly as Markdown. Keep the reading order, headings, lists and tables (as Markdown tables). " +
  "Do not describe the page, summarize, translate or add anything; output only the transcription. " +
  "If the page has no text, output nothing.";

/** A vision model reads each page from its image, two at a time. */
export const modelReader =
  (deps: {
    readonly workers: PdfRuntime;
    readonly gateway: AiGateway["Service"];
    readonly providers: ProviderRepo["Service"];
    readonly analytics: AnalyticsRepo["Service"];
    readonly modelId: string;
    readonly approved: ScanModelConnection;
  }): ScanReader =>
  ({ bytes, pages, runOptions }) =>
    Effect.gen(function* () {
      const images = yield* Effect.tryPromise({
        try: (signal) =>
          deps.workers.run(
            { kind: "render", bytes, pages, longEdge: PDF_RASTER.visionLongEdge },
            signal,
            { ...runOptions, timeoutMs: scanJobTimeoutMs(pages.length) },
          ),
        catch: workerFailure,
      });
      const model = yield* deps.providers.getModel(deps.modelId);
      const owner = runOptions.owner;
      // Each page on its own: one failed page must not discard the ones already paid for.
      const read = yield* Effect.forEach(
        images,
        (image) =>
          deps.gateway
            .generateText({
              modelId: deps.modelId,
              expectedConnection: deps.approved,
              maxOutputTokens: 8000,
              prompt: Prompt.make([
                {
                  role: "user",
                  content: [
                    { type: "file", mediaType: "image/jpeg", data: image.bytes },
                    { type: "text", text: TRANSCRIBE },
                  ],
                },
              ]),
            })
            .pipe(
              Effect.tap((result) => {
                if (!owner) return Effect.void;
                const totals = emptyUsageTotals();
                addFinishUsage(totals, { usage: result.usage, metadata: result.finishMetadata });
                if (!totals.sawUsage) return Effect.void;
                return deps.analytics.record({
                  userId: owner,
                  kind: "ocr",
                  modelId: deps.modelId,
                  modelName: model?.displayName ?? deps.modelId,
                  status: "complete",
                  inputTokens: totals.inputTokens,
                  outputTokens: totals.outputTokens,
                  cachedInputTokens: totals.cachedInputTokens,
                  cacheWriteTokens: totals.cacheWriteTokens,
                  reasoningTokens: totals.reasoningTokens,
                  ...resolveCost(totals, model?.pricing),
                });
              }),
              Effect.map((result) => ({ page: image.page, text: tidy(stripFence(result.text)) })),
              Effect.mapError((error): ScanFailure => {
                if (error._tag !== "ProviderUnreachable")
                  return { reason: "the reading model is not available", transient: false };
                const kind = error.diagnostic?.kind;
                return {
                  reason: `the reading model failed: ${error.message}`,
                  transient:
                    kind === "RateLimitError" ||
                    kind === "InternalProviderError" ||
                    kind === "NetworkError" ||
                    kind === undefined,
                  ...(error.diagnostic?.retryAfterMs === undefined
                    ? {}
                    : { retryAfterMs: error.diagnostic.retryAfterMs }),
                };
              }),
              Effect.result,
            ),
        { concurrency: 2 },
      );
      const pagesRead = read.flatMap((page) => (page._tag === "Success" ? [page.success] : []));
      const failed = read.find((page) => page._tag === "Failure");
      return failed?._tag === "Failure"
        ? ({ ok: false, failure: failed.failure, pages: pagesRead } satisfies ScanBatchResult)
        : ({ ok: true, pages: pagesRead } satisfies ScanBatchResult);
    }).pipe(
      Effect.catch((failure) => Effect.succeed<ScanBatchResult>({ ok: false, failure, pages: [] })),
    );

/** Models often wrap a whole answer in one Markdown fence; the transcription is inside. */
const stripFence = (text: string) => {
  const fenced = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return fenced ? fenced[1]! : text;
};
