import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { DOCUMENT_CSP } from "./server/csp.ts";

export default {
  fetch: createStartHandler((context) => {
    // Registered API handlers run before this document fallback. Missing endpoints
    // must not boot the application when a client expected JSON, an asset or SSE.
    const path = new URL(context.request.url).pathname;
    if (/^\/(?:api|assets|_serverFn)(?:\/|$)/.test(path)) {
      return new Response("Not found", { status: 404 });
    }
    return Promise.resolve(defaultStreamHandler(context)).then((result) => {
      // Set the header on the response the handler built and hand that same
      // one back. Copying its body into a new Response drops the last chunk
      // and never closes the stream, which leaves a shell that loads forever.
      const response = result instanceof Response ? result : result.response;
      response.headers.set("Content-Security-Policy", DOCUMENT_CSP);
      return result;
    });
  }),
};
