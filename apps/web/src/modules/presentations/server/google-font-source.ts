import { Context, Effect, Layer, Schema } from "effect";
import { FONT_LIMITS } from "../limits.ts";
import { googleFontsCssUrl, parseGoogleFontsCss, type GoogleFontFamily } from "../google-fonts.ts";

export class FontFetchFailed extends Schema.TaggedError<FontFetchFailed>()("FontFetchFailed", {
  family: Schema.String,
}) {}

const FETCH_TIMEOUT_MS = 10_000;
const CSS_BYTES = 64 * 1024;

/** Reads a body up to `limit` bytes; a longer one is refused rather than truncated. */
async function boundedBytes(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error("too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const get = async (url: string, limit: number) => {
  // No redirects: both hosts are fixed, and a redirect could lead anywhere.
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return boundedBytes(response, limit);
};

export interface FetchedFace {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly bytes: Uint8Array;
}

/**
 * Where curated Google families come from. Only fonts.googleapis.com and
 * fonts.gstatic.com are ever contacted, and only for a catalogue family, so
 * nothing a model writes chooses an address.
 */
export class GoogleFontSource extends Context.Service<
  GoogleFontSource,
  {
    fetchFamily(family: GoogleFontFamily): Effect.Effect<readonly FetchedFace[], FontFetchFailed>;
  }
>()("chat/presentations/GoogleFontSource") {
  static readonly layer = Layer.succeed(
    GoogleFontSource,
    GoogleFontSource.of({
      fetchFamily: (family) =>
        Effect.tryPromise({
          try: async () => {
            const css = new TextDecoder().decode(await get(googleFontsCssUrl(family), CSS_BYTES));
            const files = parseGoogleFontsCss(css);
            if (!files.length) throw new Error("no faces");
            return Promise.all(
              files.map(async (file) => ({
                bold: file.bold,
                italic: file.italic,
                bytes: await get(file.url, FONT_LIMITS.fileBytes),
              })),
            );
          },
          catch: () => new FontFetchFailed({ family }),
        }),
    }),
  );
}
