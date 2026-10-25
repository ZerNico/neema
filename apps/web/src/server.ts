// First: registers the locale strategy before any module renders a message.
import "~/i18n/choice.ts";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { paraglideMiddleware } from "./paraglide/server.js";
import { documentCsp } from "./server/csp.ts";

const production = process.env.NODE_ENV === "production";

const handler = createStartHandler((context) => {
  // Registered API handlers run before this document fallback. Missing endpoints
  // must not boot the application when a client expected JSON, an asset or SSE.
  const path = new URL(context.request.url).pathname;
  if (/^\/(?:api|assets|_serverFn|\.well-known)(?:\/|$)/.test(path)) {
    return new Response("Not found", { status: 404 });
  }
  return Promise.resolve(defaultStreamHandler(context)).then((result) => {
    // Set the header on the response the handler built and hand that same
    // one back. Copying its body into a new Response drops the last chunk
    // and never closes the stream, which leaves a shell that loads forever.
    const response = result instanceof Response ? result : result.response;
    response.headers.set(
      "Content-Security-Policy",
      documentCsp(production, context.router.options.ssr?.nonce),
    );
    // The nonce is this response's alone; a cached copy would carry a stale one.
    response.headers.set("Cache-Control", "no-store");
    return result;
  });
});

export default {
  // Every request runs in its locale (the cookie, else Accept-Language), so
  // code still in the request can read it. Effects cannot: see run-server-fn.ts.
  fetch: (request: Request) => paraglideMiddleware(request, () => handler(request)),
};
