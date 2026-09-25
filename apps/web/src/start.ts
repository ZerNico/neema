import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { reportUnexpectedFailures } from "~/server/unexpected-failure.ts";

// Server functions are same-origin RPC: a request must say it came from this
// origin (Sec-Fetch-Site, else Origin or Referer), and one saying nothing is
// refused. Anything outside the browser app talks to /api routes instead.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

// One nonce per request. The router stamps it on every script it streams, and
// server.ts names it in the document's CSP. A hash cannot work: Start's stream
// scripts differ on each render.
const cspNonceMiddleware = createMiddleware().server(({ next }) => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return next({ context: { cspNonce: btoa(String.fromCharCode(...bytes)) } });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, cspNonceMiddleware],
  functionMiddleware: [reportUnexpectedFailures],
}));
