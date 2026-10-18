import { createFileRoute } from "@tanstack/react-router";
import { currentAuth, mcpResource } from "~/modules/auth/server/auth.ts";

/**
 * OAuth discovery for the MCP endpoint, served at the origin's root where
 * clients look. `@better-auth/mcp` answers the protected-resource document
 * and the provider the authorization-server one, both from the auth handler.
 */
const discover = async ({ request }: { request: Request }) => {
  if (!mcpResource()) return new Response("Not found", { status: 404 });
  return (await currentAuth()).handler(request);
};

export const Route = createFileRoute("/.well-known/$")({
  server: { handlers: { GET: discover, HEAD: discover } },
});
