import { createMiddleware } from "@tanstack/react-start";
import { auth } from "./auth.ts";

// Requires an authenticated session; provides { session } in context.
export const requireSession = createMiddleware().server(async ({ request, next }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return next({ context: { session } });
});

// Requires an admin session; provides { session } in context.
export const requireAdmin = createMiddleware().server(async ({ request, next }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }
  if (session.user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
  return next({ context: { session } });
});
