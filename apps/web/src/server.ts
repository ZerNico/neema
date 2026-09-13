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
      const response = result instanceof Response ? result : result.response;
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", DOCUMENT_CSP);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  }),
};
