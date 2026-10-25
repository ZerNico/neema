import { createMiddleware } from "@tanstack/react-start";
import { IMPERSONATING_BODY, isImpersonated, UNAUTHENTICATED_BODY } from "../identity.ts";
import { NOT_APPROVED_BODY } from "../signup.ts";
import { sessionFromHeaders } from "./auth.ts";

// The Start client drops the status of a non-OK response and keeps only its
// text, so the body is what `isUnauthenticatedError` and `isNotApprovedError` match on.
const unauthenticated = () => new Response(UNAUTHENTICATED_BODY, { status: 401 });
const notApproved = () => new Response(NOT_APPROVED_BODY, { status: 403 });

const approvedSession = async (request: Request) => {
  const current = await sessionFromHeaders(request.headers);
  if (!current) throw unauthenticated();
  if (!current.approved) throw notApproved();
  return current.session;
};

/**
 * Requires an authenticated, approved session; provides { session } in context.
 */
export const requireSession = createMiddleware().server(async ({ request, next }) =>
  next({ context: { session: await approvedSession(request) } }),
);

/**
 * Like `requireSession`, and the person themselves rather than an admin acting
 * as them. For whatever outlasts the session: keys, connections, schedules.
 * Better Auth's own endpoints are held to the same rule by its `before` hook.
 */
export const requireOwnSession = createMiddleware().server(async ({ request, next }) => {
  const session = await approvedSession(request);
  if (isImpersonated(session.session)) throw new Response(IMPERSONATING_BODY, { status: 403 });
  return next({ context: { session } });
});

/**
 * Requires an admin session; provides { session } in context.
 */
export const requireAdmin = createMiddleware().server(async ({ request, next }) => {
  const session = await approvedSession(request);
  if (session.user.role !== "admin") throw new Response("Forbidden", { status: 403 });
  return next({ context: { session } });
});
