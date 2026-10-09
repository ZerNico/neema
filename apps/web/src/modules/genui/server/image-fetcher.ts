import { Context, Effect, Layer, Schema } from "effect";
import { IMAGE_MEDIA_TYPES } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType } from "~/modules/attachments/server/validation.ts";
import { readCapped } from "~/modules/tools/server/extraction.ts";
import { fetchPinned, resolvePublicHttpUrl } from "~/modules/tools/server/url-safety.ts";
import { acceptableImageSize, readImageSize, type ImageSize } from "./image-header.ts";

export class ImageFetchFailed extends Schema.TaggedError<ImageFetchFailed>()("ImageFetchFailed", {
  url: Schema.String,
  message: Schema.String,
}) {}

export const IMAGE_FETCH_LIMITS = {
  bytes: 2 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 8_000,
} as const;

export interface FetchedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly size: ImageSize;
}

/**
 * Fetches one search image from the public web: each hop re-validated and
 * DNS-pinned like `read_url`, the body capped, the type sniffed (never SVG),
 * and the dimensions read from the header. A service so tests can replace
 * the network.
 */
export class ImageFetcher extends Context.Service<
  ImageFetcher,
  { fetch(url: string): Effect.Effect<FetchedImage, ImageFetchFailed> }
>()("genui/ImageFetcher") {
  static readonly layer = Layer.succeed(ImageFetcher, {
    fetch: (url: string) => fetchImage(url),
  });
}

/** The network fetch the engine uses unless a test provides its own `ImageFetcher`. */
export const fetchImage = Effect.fn("ImageFetcher.fetch")(function* (url: string) {
  const fail = (message: string) => new ImageFetchFailed({ url, message });
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= IMAGE_FETCH_LIMITS.redirects; hop++) {
    const target = yield* resolvePublicHttpUrl(current).pipe(
      Effect.mapError((e) => fail(e.reason)),
    );
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        fetchPinned(target, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_FETCH_LIMITS.timeoutMs)]),
          headers: { accept: IMAGE_MEDIA_TYPES.join(", ") },
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
  const body = response.body;
  const read = yield* Effect.tryPromise({
    try: () => readCapped(body, IMAGE_FETCH_LIMITS.bytes),
    catch: (e) => fail(`body read failed: ${String(e)}`),
  });
  if (read.truncated) return yield* fail("image too large");
  const mediaType = sniffBinaryMediaType(read.data);
  if (!mediaType || !(IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType))
    return yield* fail("not a supported image");
  const size = readImageSize(read.data, mediaType);
  if (!acceptableImageSize(size)) return yield* fail("image dimensions out of range");
  return { bytes: read.data, mediaType, size };
});
