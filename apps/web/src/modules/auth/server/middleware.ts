import { createMiddleware } from "@tanstack/react-start";
import { UNAUTHENTICATED_BODY } from "../identity.ts";
import { NOT_APPROVED_BODY } from "../signup.ts";
import { sessionFromHeaders } from "./auth.ts";

// The Start client drops the status of a non-OK response and keeps only its
// text, so the body is what `isUnauthenticatedError` matches on.
const unauthenticated = () => new Response(UNAUTHENTICATED_BODY, { status: 401 });
const notApproved = () => new Response(NOT_APPROVED_BODY, { status: 403 });

/**
 * Requires an authenticated, approved session; provides { session } in context.
 */
export const requireSession = createMiddleware().server(async ({ request, next }) => {
  const current = await sessionFromHeaders(request.headers);
  if (!current) throw unauthenticated();
  if (!current.approved) throw notApproved();
  return next({ context: { session: current.session } });
});

/**
 * Requires an admin session; provides { session } in context.
 */
export const requireAdmin = createMiddleware().server(async ({ request, next }) => {
  const current = await sessionFromHeaders(request.headers);
  if (!current) throw unauthenticated();
  if (!current.approved) throw notApproved();
  if (current.session.user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
  return next({ context: { session: current.session } });
});
