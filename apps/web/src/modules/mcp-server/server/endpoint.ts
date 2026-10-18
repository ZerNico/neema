import { mcpGate, type McpGateDeps } from "./auth.ts";
import { createMcpServerHandler } from "./handler.ts";
import type { McpRun } from "./tools/define.ts";
import type { McpServices } from "./tools/index.ts";

export type McpEndpointDeps = McpGateDeps & { run: McpRun<McpServices>; stateKey: Uint8Array };

/**
 * This instance as an MCP server. A browser page on another origin is turned
 * away even with a token: MCP clients call from their own process and send no
 * `Origin`, while a page reaching here by DNS rebinding sends its own.
 */
export const mcpEndpoint = (deps: McpEndpointDeps) => {
  const origin = new URL(deps.resource).origin;
  const gate = mcpGate(deps);
  const handler = createMcpServerHandler({ origin, run: deps.run, stateKey: deps.stateKey });
  return async (request: Request) => {
    // Compared whole: scheme and port matter, which the SDK helper ignores.
    const sent = request.headers.get("origin");
    if (sent !== null && sent !== origin) return new Response("Forbidden", { status: 403 });
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
  };
};
