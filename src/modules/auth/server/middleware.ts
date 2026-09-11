import { createMiddleware } from "@tanstack/react-start";
import { UNAUTHENTICATED_BODY } from "../identity.ts";
import { currentAuth } from "./auth.ts";

// The body is the contract with `isUnauthenticatedError`: the Start client
// drops the status of a non-OK response and keeps only its text.
const unauthenticated = () => new Response(UNAUTHENTICATED_BODY, { status: 401 });

// Requires an authenticated session; provides { session } in context.
export const requireSession = createMiddleware().server(async ({ request, next }) => {
  const session = await (await currentAuth()).api.getSession({ headers: request.headers });
  if (!session) throw unauthenticated();
  return next({ context: { session } });
});

// Requires an admin session; provides { session } in context.
export const requireAdmin = createMiddleware().server(async ({ request, next }) => {
  const session = await (await currentAuth()).api.getSession({ headers: request.headers });
  if (!session) throw unauthenticated();
  if (session.user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
  return next({ context: { session } });
});
