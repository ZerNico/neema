import { createFileRoute } from "@tanstack/react-router";
import { currentAuth, mayConnectApps, mcpResource } from "~/modules/auth/server/auth.ts";
import { API_KEY_PREFIX } from "~/modules/api-keys/schema.ts";
import { apiKeyGrant } from "~/modules/mcp-server/server/api-key-grant.ts";
import { mcpEndpoint } from "~/modules/mcp-server/server/endpoint.ts";
import { requestStateKey } from "~/modules/mcp-server/server/request-state.ts";
import { runtime } from "~/server/runtime.ts";

/** One endpoint per public address, built on first use; the address does not change at runtime. */
let endpoint: { resource: string; serve: (request: Request) => Promise<Response> } | null = null;

const serve = async ({ request }: { request: Request }) => {
  const resource = mcpResource();
  if (!resource) return new Response("Not found", { status: 404 });
  if (endpoint?.resource !== resource) {
    endpoint = {
      resource,
      serve: mcpEndpoint({
        resource,
        // A key never reaches the OAuth provider, nor a token the key table.
        grantFor: async (token) =>
          token.startsWith(API_KEY_PREFIX)
            ? runtime.runPromise(apiKeyGrant(token, resource))
            : (await currentAuth()).api.verifyMcpToken({ body: { token } }),
        allowed: mayConnectApps,
        run: (effect, signal) => runtime.runPromise(effect, { signal }),
        // The key every stored credential is sealed with, which every instance shares.
        stateKey: requestStateKey(process.env.ENCRYPTION_KEY ?? ""),
      }),
    };
  }
  return endpoint.serve(request);
};

export const Route = createFileRoute("/api/mcp")({
  server: { handlers: { GET: serve, POST: serve, DELETE: serve } },
});
