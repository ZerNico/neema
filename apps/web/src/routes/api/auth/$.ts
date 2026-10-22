import { createFileRoute } from "@tanstack/react-router";
import { currentAuth } from "~/modules/auth/server/auth.ts";

/**
 * Files are kept by the browser and only reused once the server has checked
 * access again, but the bytes stay on disk. Signing out drops them, so the
 * next person at a shared computer finds nothing of the last one's.
 */
const clearingCacheOnSignOut = (request: Request, response: Response) => {
  if (!response.ok || !new URL(request.url).pathname.endsWith("/sign-out")) return response;
  const headers = new Headers(response.headers);
  headers.set("Clear-Site-Data", '"cache"');
  return new Response(response.body, { status: response.status, headers });
};

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => (await currentAuth()).handler(request),
      POST: async ({ request }) =>
        clearingCacheOnSignOut(request, await (await currentAuth()).handler(request)),
    },
  },
});
