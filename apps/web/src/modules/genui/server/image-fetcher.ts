import { Context, Effect, Layer, Schema } from "effect";
import { IMAGE_MEDIA_TYPES } from "~/modules/attachments/constants.ts";
import { sniffBinaryMediaType } from "~/modules/attachments/server/validation.ts";
import { fetchPublic, readCapped } from "~/modules/tools/server/public-fetch.ts";
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
  const { response } = yield* fetchPublic(url, {
    headers: { accept: IMAGE_MEDIA_TYPES.join(", ") },
    timeoutMs: IMAGE_FETCH_LIMITS.timeoutMs,
    redirects: IMAGE_FETCH_LIMITS.redirects,
  }).pipe(Effect.mapError((error) => fail(error.reason)));
  if (!response.ok) {
    void response.body?.cancel();
    return yield* fail(`HTTP ${response.status}`);
  }
  const body = response.body;
  const read = yield* readCapped(body, IMAGE_FETCH_LIMITS.bytes).pipe(
    Effect.mapError((error) => fail(error.reason)),
  );
  if (read.truncated) return yield* fail("image too large");
  const mediaType = sniffBinaryMediaType(read.data);
  if (!mediaType || !(IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType))
    return yield* fail("not a supported image");
  const size = readImageSize(read.data, mediaType);
  if (!acceptableImageSize(size)) return yield* fail("image dimensions out of range");
  return { bytes: read.data, mediaType, size };
});
