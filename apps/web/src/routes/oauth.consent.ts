import { createFileRoute } from "@tanstack/react-router";
import { packQuery } from "~/modules/mcp-server/authorize-query.ts";

/**
 * Where the authorization server sends a signed-in browser to decide. The
 * signature covers repeated parameters, so the query is packed whole from
 * the raw request before the router can parse it.
 */
export const Route = createFileRoute("/oauth/consent")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const query = new URL(request.url).search.slice(1);
        return new Response(null, {
          status: 302,
          // Relative, so a proxy in front never rewrites its origin.
          headers: { location: `/oauth/approve?request=${packQuery(query)}` },
        });
      },
    },
  },
});
