import { Effect } from "effect";
import { fetchPinned, resolvePublicHttpUrl } from "~/modules/tools/server/url-safety.ts";

/** A metadata document is a few hundred bytes; anything near this is not one. */
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

const tooLarge = () => new Error("Client metadata is too large.");

const capped = (body: ReadableStream<Uint8Array>) => {
  let read = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.byteLength;
        if (read > MAX_BYTES) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
};

/**
 * Fetches a client's metadata document for `@better-auth/cimd`, which requires
 * one DNS lookup, no special-use addresses, a pinned connection and no
 * redirects. `fetchPinned` connects to the checked addresses and never
 * follows a redirect. One deadline covers the lookup, the answer and its body.
 */
export const fetchClientMetadata = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://")) throw new Error("Client metadata must be served over HTTPS.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(init?.signal ? [init.signal] : []),
  ]);
  const target = await Effect.runPromise(resolvePublicHttpUrl(url), { signal });
  const response = await fetchPinned(target, { ...init, method: init?.method ?? "GET", signal });
  // A 304 to a conditional request has no body to read.
  if (!response.body) return response;
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await response.body.cancel();
    throw tooLarge();
  }
  const body = new Uint8Array(await new Response(capped(response.body)).arrayBuffer());
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
