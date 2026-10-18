import { MCP_PATH } from "./scopes.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The MCP endpoint's URL, which every token is bound to, or undefined when the
 * public address cannot carry one. OAuth requires HTTPS except on loopback, and
 * `@better-auth/mcp` throws on anything else while the auth instance is built,
 * which would end every sign-in rather than only MCP.
 */
export const mcpResourceFor = (publicUrl: string | undefined) => {
  if (!publicUrl) return undefined;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  return secure && !url.username && !url.password ? `${url.origin}${MCP_PATH}` : undefined;
};
