import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

export default {
  fetch: createStartHandler((context) => {
    // Registered API handlers run before this document fallback. Missing endpoints
    // must not boot the application when a client expected JSON, an asset or SSE.
    const path = new URL(context.request.url).pathname;
    if (/^\/(?:api|assets|_serverFn)(?:\/|$)/.test(path)) {
      return new Response("Not found", { status: 404 });
    }
    return defaultStreamHandler(context);
  }),
};
