import {
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { McpGrant } from "~/modules/auth/server/mcp-access.ts";

/** Who an MCP request acts for. Read from `AuthInfo.extra`, which only the gate writes. */
export interface McpPrincipal {
  userId: string;
  clientId: string;
  scopes: ReadonlySet<string>;
}

export interface McpGateDeps {
  /** The MCP endpoint's absolute URL, the audience every token must name. */
  resource: string;
  /** The grant behind a bearer token, or null for an unknown, expired or revoked one. */
  grantFor: (token: string) => Promise<McpGrant | null>;
  /** Approved, not banned, and holding the `mcp` capability. */
  allowed: (userId: string) => Promise<boolean>;
}

const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

/** Bearer only: a cookie session never authenticates an MCP request. */
export const mcpGate = ({ resource, grantFor, allowed }: McpGateDeps) =>
  requireBearerAuth({
    verifier: {
      verifyAccessToken: async (token): Promise<AuthInfo> => {
        const grant = await grantFor(token);
        if (!grant) throw invalid("Invalid access token");
        // Checked on every request, so a ban, a rejection or a lost capability
        // ends access on the next call rather than when the token runs out. A
        // 401 sends the app back to consent, which says why it cannot continue.
        if (!(await allowed(grant.userId))) throw invalid("This account cannot connect apps.");
        return {
          token,
          clientId: grant.clientId,
          scopes: [...grant.scopes],
          expiresAt: grant.expiresAt,
          // The SDK refuses a token reported for no resource or another one.
          ...(grant.audience.includes(resource) ? { resource: new URL(resource) } : {}),
          extra: { userId: grant.userId },
        };
      },
    },
    expectedResource: new URL(resource),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
  });

export const principalOf = (auth: AuthInfo | undefined): McpPrincipal | null => {
  const userId = auth?.extra?.["userId"];
  if (!auth || typeof userId !== "string") return null;
  return { userId, clientId: auth.clientId, scopes: new Set(auth.scopes) };
};
