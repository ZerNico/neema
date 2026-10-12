import { abortable } from "./calls.ts";

export async function receiveBytes(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    signal.throwIfAborted();
    if (Number(response.headers.get("content-length")) > limit)
      throw new Error("It is too large to save.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- receiving one bounded chunk at a time
      const { done, value } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("It is too large to save.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    complete = true;
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

const REDIRECT_MAX = 8;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class BlockedSaveSite extends Error {
  constructor(readonly url: string) {
    super("That site is not allowed in this chat.");
  }
}

/** Each redirect is authorized before contact, not after Fetch has followed it. */
export async function fetchAllowed(
  url: string,
  fetchUrl: (url: string, signal: AbortSignal) => Promise<Response>,
  allowed: (url: string) => boolean,
  signal: AbortSignal,
) {
  let current = url;
  for (let hop = 0; hop <= REDIRECT_MAX; hop++) {
    signal.throwIfAborted();
    if (!/^https?:$/.test(new URL(current).protocol)) throw new Error("Not a web address.");
    if (!allowed(current)) throw new BlockedSaveSite(current);
    const pending = fetchUrl(current, signal);
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- authorize each hop before issuing it
    const response = await abortable(pending, signal);
    signal.throwIfAborted();
    if (!REDIRECTS.has(response.status)) return response;
    // oxlint-disable-next-line eslint/no-await-in-loop -- release each redirect body before the next contact
    await abortable(response.body?.cancel() ?? Promise.resolve(), signal);
    const location = response.headers.get("location");
    if (!location) throw new Error("The redirect has no address.");
    if (hop === REDIRECT_MAX) throw new Error("Too many redirects.");
    current = new URL(location, current).href;
  }
  throw new Error("Too many redirects.");
}
