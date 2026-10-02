import { Context, Duration, Effect, Layer, Schema } from "effect";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { fetchPinned, resolvePublicHttpUrl } from "./url-safety.ts";

export class PageExtractionError extends Schema.TaggedError<PageExtractionError>()(
  "PageExtractionError",
  { url: Schema.String, message: Schema.String },
) {}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = MAX_ATTACHMENT_BYTES;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface ExtractedPage {
  readonly url: string;
  readonly title: string | null;
  readonly content: string;
  readonly truncated: boolean;
}

/**
 * Fetches a page as Markdown: HTML through the reader, a PDF through the
 * configured document parser, JSON, CSV and Markdown as text. Public http(s)
 * only; each hop is re-validated and DNS-pinned.
 */
export class PageExtractor extends Context.Service<
  PageExtractor,
  {
    extract(input: {
      url: string;
      charCap: number;
    }): Effect.Effect<ExtractedPage, PageExtractionError>;
  }
>()("chat/tools/PageExtractor") {
  static readonly layer = Layer.effect(
    PageExtractor,
    Effect.gen(function* () {
      const parser = yield* DocumentParser;
      return PageExtractor.of({
        extract: Effect.fn("PageExtractor.extract")(function* (input) {
          const fail = (message: string) => new PageExtractionError({ url: input.url, message });

          // Follow redirects manually so each hop is re-validated and pinned.
          let current = input.url;
          let response: Response | null = null;
          for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const target = yield* resolvePublicHttpUrl(current).pipe(
              Effect.mapError((e) => fail(e.reason)),
            );
            const res = yield* Effect.tryPromise({
              try: () =>
                fetchPinned(target, {
                  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                  headers: { accept: ACCEPT },
                }),
              catch: (e) => fail(`fetch failed: ${String(e)}`),
            });
            if (res.status >= 300 && res.status < 400) {
              void res.body?.cancel();
              const location = res.headers.get("location");
              if (!location) return yield* fail(`redirect without location (${res.status})`);
              current = new URL(location, target.url).toString();
              continue;
            }
            if (!res.ok) {
              void res.body?.cancel();
              return yield* fail(`HTTP ${res.status}`);
            }
            response = res;
            break;
          }
          if (!response) return yield* fail("too many redirects");

          const kind = contentKind(response.headers.get("content-type") ?? "", current);
          if (!kind) {
            void response.body?.cancel();
            return yield* fail(
              `unsupported content-type: ${response.headers.get("content-type") ?? "none"}`,
            );
          }
          const body = response.body;
          const bytes = yield* Effect.tryPromise({
            try: () => readCapped(body, kind === "pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES),
            catch: (e) => fail(`body read failed: ${String(e)}`),
          });
          if (kind === "pdf" && bytes.truncated)
            return yield* fail(`PDF larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB`);

          const page = yield* kind === "html"
            ? Effect.tryPromise({
                try: async () => {
                  const { document } = parseHTML(new TextDecoder().decode(bytes.data));
                  const extracted = await Defuddle(document, current, { markdown: true });
                  return { title: extracted.title ?? null, raw: extracted.content ?? "" };
                },
                catch: (e) => fail(`extraction failed: ${String(e)}`),
              })
            : kind === "pdf"
              ? parser
                  .parsePdf({ bytes: bytes.data, fileName: fileNameOf(current, "document.pdf") })
                  .pipe(
                    Effect.map((parsed) => ({ title: null, raw: parsed.text })),
                    Effect.mapError((e) => fail(`PDF could not be read: ${e.reason}`)),
                    // A page's PDF is anyone's file: interrupting aborts the
                    // parse between pages, so one cannot hold the server.
                    Effect.timeoutOrElse({
                      duration: PDF_TIMEOUT,
                      orElse: () => Effect.fail(fail("PDF took too long to read")),
                    }),
                  )
              : Effect.succeed({
                  title: null,
                  raw: textBody(kind, new TextDecoder().decode(bytes.data)),
                });

          const truncated = page.raw.length > input.charCap || bytes.truncated;
          // Truncate at a code-point boundary; mark the cut explicitly.
          const content = truncated
            ? `${Array.from(page.raw).slice(0, input.charCap).join("")}\n\n[content truncated]`
            : page.raw;

          return { url: current, title: page.title, content, truncated };
        }),
      });
    }),
  );
}

type ContentKind = "html" | "pdf" | "json" | "csv" | "markdown" | "text";

const ACCEPT =
  "text/html,application/xhtml+xml,application/pdf;q=0.9,application/json;q=0.9,text/markdown;q=0.9,text/csv;q=0.9,text/plain;q=0.8";

/** What a response is, from its declared type, or a `.pdf` path when a server says octet-stream. */
export const contentKind = (contentType: string, url: string): ContentKind | null => {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "application/pdf") return "pdf";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "text/csv") return "csv";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/plain") return "text";
  if (
    (type === "application/octet-stream" || type === "") &&
    new URL(url).pathname.toLowerCase().endsWith(".pdf")
  )
    return "pdf";
  return null;
};

const PDF_TIMEOUT = Duration.seconds(20);

/** Structured text reads best fenced, so its shape survives the model's Markdown. */
export const textBody = (kind: ContentKind, text: string) => {
  if (kind === "json" || kind === "csv") {
    // A loop, not a spread: a body of many short backtick runs would pass more
    // arguments than the call stack holds.
    let longestRun = 2;
    for (const match of text.matchAll(/`+/g))
      if (match[0].length > longestRun) longestRun = match[0].length;
    const fence = "`".repeat(longestRun + 1);
    return `${fence}${kind}\n${text}\n${fence}`;
  }
  return text;
};

/** The last path segment, decoded when it can be; a malformed escape keeps it as written. */
export const fileNameOf = (url: string, fallback: string) => {
  const segment = new URL(url).pathname.split("/").at(-1) || "";
  try {
    return decodeURIComponent(segment) || fallback;
  } catch {
    return segment || fallback;
  }
};

export const readCapped = async (body: ReadableStream<Uint8Array> | null, cap: number) => {
  const reader = body?.getReader();
  if (!reader) return { data: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= cap) {
      truncated = size > cap;
      await reader.cancel();
      break;
    }
  }
  const data = new Uint8Array(Math.min(size, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, data.byteLength - offset));
    data.set(part, offset);
    offset += part.byteLength;
  }
  return { data, truncated };
};
