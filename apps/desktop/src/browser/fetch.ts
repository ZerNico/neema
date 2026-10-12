import { net, type Session } from "electron";

const headersOf = (values: Record<string, string | string[]>) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  return headers;
};

/**
 * Electron fetch rejects manual redirects. Native requests expose the headers
 * without following, so the caller can authorize each new contact itself.
 */
export const fetchManual = (profile: Session, url: string, signal: AbortSignal, limit: number) =>
  new Promise<Response>((resolve, reject) => {
    signal.throwIfAborted();
    const request = net.request({
      url,
      session: profile,
      credentials: "include",
      redirect: "manual",
    });
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let ended = false;
    let received = 0;
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const fail = (error: unknown) => {
      if (ended) return;
      ended = true;
      cleanup();
      if (!settled) reject(error);
      else body?.error(error);
      request.abort();
    };
    const cancel = () => fail(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    request.on("error", fail);
    request.on("redirect", (status, _method, destination, values) => {
      if (ended) return;
      const headers = headersOf(values);
      headers.set("location", destination);
      settled = true;
      ended = true;
      cleanup();
      resolve(new Response(null, { status, headers }));
      // Never call followRedirect, even when this destination was already granted.
      request.abort();
    });
    request.on("response", (response) => {
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("The request was aborted.")));
      if (ended) return;
      const headers = headersOf(response.headers);
      const declared = Number(headers.get("content-length"));
      if (declared > limit) return fail(new Error("The file is too large."));
      if ([204, 205, 304].includes(response.statusCode)) {
        settled = true;
        ended = true;
        cleanup();
        resolve(new Response(null, { status: response.statusCode, headers }));
        request.abort();
        return;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
        cancel() {
          if (ended) return;
          ended = true;
          cleanup();
          request.abort();
        },
      });
      // IncomingMessage has no backpressure API. Bound its producer before
      // queuing chunks as well as bounding the caller's streamed receiver.
      response.on("end", () => {
        if (ended) return;
        ended = true;
        cleanup();
        body?.close();
      });
      response.on("data", (chunk) => {
        if (ended) return;
        received += chunk.byteLength;
        if (received > limit) return fail(new Error("The file is too large."));
        body?.enqueue(chunk);
      });
      settled = true;
      resolve(new Response(stream, { status: response.statusCode, headers }));
    });
    request.end();
  });
