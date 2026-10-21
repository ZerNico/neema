import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { reportUnexpectedFailures } from "~/server/unexpected-failure.ts";
import { oversizedBody } from "~/server/body-limit.ts";
import { compressedReply } from "~/server/compress.ts";
import { refusalsReject } from "~/refusals.ts";

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

const bodyLimitMiddleware = createMiddleware().server(({ next, request, handlerType }) =>
  handlerType === "serverFn" ? (oversizedBody(request) ?? next()) : next(),
);

// The reverse proxy in front is the operator's, and nginx and Caddy leave JSON
// uncompressed by default. A chat's detail is over 100 KB of it.
const compressionMiddleware = createMiddleware().server(async ({ next, request, handlerType }) => {
  const result = await next();
  if (handlerType !== "serverFn") return result;
  const response = await compressedReply(request, result.response);
  return response ? { ...result, response } : result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    csrfMiddleware,
    bodyLimitMiddleware,
    cspNonceMiddleware,
    compressionMiddleware,
  ],
  functionMiddleware: [reportUnexpectedFailures, refusalsReject],
}));
