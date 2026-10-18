import { Effect, Schema } from "effect";
import { fetchPinned, resolvePublicHttpUrl } from "./url-safety.ts";

export class PublicFetchFailed extends Schema.TaggedError<PublicFetchFailed>()(
  "PublicFetchFailed",
  { reason: Schema.String },
) {}
const fail = (reason: string) => new PublicFetchFailed({ reason });

/**
 * A GET of a public address chosen by a model, a page or a remote service.
 * Redirects are followed by hand so each hop is checked and connected to at the
 * address that was checked. Answers the first response that is not a redirect,
 * whatever its status, with the address it came from. Interrupting the caller
 * ends the request.
 */
export const fetchPublic = Effect.fn("fetchPublic")(function* (
  url: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly timeoutMs: number;
    readonly redirects: number;
    /** Why this hop may not be fetched, or null; for callers bound to a few hosts. */
    readonly refuseHop?: (url: URL) => string | null;
  },
) {
  let current = url;
  for (let hop = 0; hop <= options.redirects; hop++) {
    const refusal = options.refuseHop?.(new URL(current)) ?? null;
    if (refusal !== null) return yield* fail(refusal);
    const target = yield* resolvePublicHttpUrl(current).pipe(
      Effect.mapError((error) => fail(error.reason)),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchPinned(target, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
          ...(options.headers ? { headers: options.headers } : {}),
        }),
      catch: (error) => fail(`fetch failed: ${String(error)}`),
    });
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    void response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) return yield* fail(`redirect without location (${response.status})`);
    // A page can send any text here; one that is not a URL fails this fetch, not the caller.
    const next = URL.parse(location, target.url);
    if (!next) return yield* fail(`redirect to an invalid location (${response.status})`);
    current = next.toString();
  }
  return yield* fail("too many redirects");
});

/**
 * The first `cap` bytes of a body, and whether there were more. Interrupting
 * the caller cancels the read, so Stop does not wait out a slow body.
 */
export const readCapped = (body: ReadableStream<Uint8Array> | null, cap: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      const reader = body?.getReader();
      if (!reader) return { data: new Uint8Array(), truncated: false };
      const stop = () => void reader.cancel();
      signal.addEventListener("abort", stop, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      try {
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
      } finally {
        signal.removeEventListener("abort", stop);
      }
      const data = new Uint8Array(Math.min(size, cap));
      let offset = 0;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, Math.min(chunk.byteLength, data.byteLength - offset));
        data.set(part, offset);
        offset += part.byteLength;
      }
      return { data, truncated };
    },
    catch: (error) => fail(`body read failed: ${String(error)}`),
  });
