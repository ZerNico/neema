import { createMcpHandler, McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { principalOf } from "./auth.ts";
import { MAX_REQUEST_BYTES } from "./delegate/files.ts";
import { turnStateCodec } from "./request-state.ts";
import { installFileResource } from "./resources.ts";
import { installSkillPrompts } from "./skills.ts";
import type { McpRun } from "./tools/define.ts";
import { MCP_TOOLS, type McpServices } from "./tools/index.ts";

/**
 * One server per request, built for the person and app the token names, so
 * what is listed is what that grant may call. Nothing lives between requests:
 * 2026-07-28 has no sessions, and 2025-era clients are served statelessly.
 */
export const createMcpServerHandler = (deps: {
  origin: string;
  run: McpRun<McpServices>;
  /** Signs the state a call stops to ask with; shared by every process that serves this endpoint. */
  stateKey: Uint8Array;
}) => {
  const turnState = turnStateCodec(deps.stateKey);
  return createMcpHandler(
    (context: McpRequestContext) => {
      const principal = principalOf(context.authInfo);
      if (!principal) throw new Error("An MCP server was built without a verified grant.");
      const server = new McpServer(
        { name: "neema", version: "1.0.0" },
        { requestState: { verify: turnState.verify } },
      );
      if (principal.scopes.has("chats:read"))
        installFileResource(server, { principal, run: deps.run });
      if (principal.scopes.has("skills:read"))
        installSkillPrompts(server, { principal, run: deps.run });
      for (const tool of MCP_TOOLS) {
        if (principal.scopes.has(tool.scope)) {
          tool.install(server, { principal, origin: deps.origin, run: deps.run, turnState });
        }
      }
      return server;
    },
    { legacy: "stateless", maxRequestBodySize: MAX_REQUEST_BYTES },
  );
};
