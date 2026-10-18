import { createMiddleware } from "@tanstack/react-start";

/**
 * Start answers a Response a server function threw as that Response, and the
 * client call resolves with it instead of rejecting. A refusal is a failure to
 * every caller, so it is rethrown here as the Error its body describes.
 */
export const refusalsReject = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const outcome = await next();
  // Present at run time, absent from the middleware's types.
  const result: unknown = Reflect.get(outcome, "result");
  if (result instanceof Response && !result.ok) throw new Error(await result.text());
  return outcome;
});
