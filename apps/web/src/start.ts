import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { reportUnexpectedFailures } from "~/server/unexpected-failure.ts";

// Server functions are same-origin RPC: a request must say it came from this
// origin (Sec-Fetch-Site, else Origin or Referer), and one saying nothing is
// refused. Anything outside the browser app talks to /api routes instead.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [reportUnexpectedFailures],
}));
