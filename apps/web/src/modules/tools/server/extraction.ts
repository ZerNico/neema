import { Context, Effect, Layer, Schema } from "effect";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { fetchPinned, resolvePublicHttpUrl } from "./url-safety.ts";

export class PageExtractionError extends Schema.TaggedError<PageExtractionError>()(
  "PageExtractionError",
  { url: Schema.String, message: Schema.String },
) {}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface ExtractedPage {
  readonly url: string;
  readonly title: string | null;
  readonly content: string;
  readonly truncated: boolean;
}

/** Fetches a search-result page as Markdown. Public http(s) only; each hop is re-validated and DNS-pinned. */
export class PageExtractor extends Context.Service<
  PageExtractor,
  {
    extract(input: {
      url: string;
      charCap: number;
    }): Effect.Effect<ExtractedPage, PageExtractionError>;
  }
>()("chat/tools/PageExtractor") {
  static readonly layer = Layer.succeed(
    PageExtractor,
    PageExtractor.of({
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
                headers: { accept: "text/html,application/xhtml+xml" },
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

        const contentType = response.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
          return yield* fail(`unsupported content-type: ${contentType}`);
        }

        // Read at most MAX_HTML_BYTES of the body.
        const html = yield* Effect.tryPromise({
          try: async () => {
            const reader = response.body?.getReader();
            if (!reader) return "";
            const decoder = new TextDecoder();
            let out = "";
            let bytes = 0;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              out += decoder.decode(value, { stream: true });
              if (bytes >= MAX_HTML_BYTES) {
                await reader.cancel();
                break;
              }
            }
            return out;
          },
          catch: (e) => fail(`body read failed: ${String(e)}`),
        });

        const extracted = yield* Effect.tryPromise({
          try: async () => {
            const { document } = parseHTML(html);
            return await Defuddle(document, current, { markdown: true });
          },
          catch: (e) => fail(`extraction failed: ${String(e)}`),
        });

        const raw = extracted.content ?? "";
        const truncated = raw.length > input.charCap;
        // Truncate at a code-point boundary; mark the cut explicitly.
        const content = truncated
          ? `${Array.from(raw).slice(0, input.charCap).join("")}\n\n[content truncated]`
          : raw;

        return { url: current, title: extracted.title ?? null, content, truncated };
      }),
    }),
  );
}
