// First: registers the locale strategy before any module renders a message.
import "~/i18n/choice.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { defineServerRegion, detectRegion, regionIn } from "~/i18n/formats.ts";
import { getLocale } from "./paraglide/runtime.js";
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

// The request's region for `formatLocale`: the page's cookie, else what the
// browser asks for, which is how a first visit detects it.
const regions = new AsyncLocalStorage<() => string | undefined>();
defineServerRegion(() => regions.getStore()?.());

const regionFor = (request: Request) => {
  const chosen = regionIn(request.headers.get("cookie"));
  const preferred = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((part) => part.split(";")[0]!.trim())
    .filter(Boolean);
  return () => chosen ?? detectRegion(getLocale(), preferred);
};

export default {
  // Every request runs in its locale (the cookie, else Accept-Language), so
  // code still in the request can read it. Effects cannot: see run-server-fn.ts.
  fetch: (request: Request) =>
    regions.run(regionFor(request), () => paraglideMiddleware(request, () => handler(request))),
};
