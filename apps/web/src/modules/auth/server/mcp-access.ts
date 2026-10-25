import { getOAuthProviderApi, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { Schema } from "effect";

/** What a valid MCP bearer token proves: one person, through one app, with these scopes. */
export interface McpGrant {
  userId: string;
  clientId: string;
  scopes: ReadonlyArray<string>;
  audience: ReadonlyArray<string>;
  /** Seconds since the epoch. */
  expiresAt: number;
}

const VerifyBody = Schema.toStandardSchemaV1(Schema.Struct({ token: Schema.String }));

const audienceOf = (aud: unknown): string[] =>
  typeof aud === "string"
    ? [aud]
    : Array.isArray(aud)
      ? aud.filter((a) => typeof a === "string")
      : [];

/**
 * The app's own rules around `@better-auth/mcp`. Nobody the app would not let
 * in, or who may not connect apps, can authorize an app; an admin acting as
 * someone is refused before this, as everywhere in the auth instance. Bearer
 * tokens are checked in-process.
 */
export const mcpAccess = ({
  allowed,
}: {
  /** Approved, not banned, and holding the `mcp` capability. */
  allowed: (userId: string) => Promise<boolean>;
}) =>
  ({
    id: "mcp-access",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/consent" || ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx);
            // Signed out: authorize sends the person to sign in, consent refuses itself.
            if (!current) return;
            if (await allowed(current.user.id)) return;
            // A stored consent would otherwise mint a code the gate then
            // refuses, and the app would ask again forever. The consent page
            // says why instead.
            if (ctx.path === "/oauth2/authorize") {
              return { context: { query: { ...ctx.query, prompt: "consent" } } };
            }
            throw new APIError("FORBIDDEN", { message: "This account cannot connect apps." });
          }),
        },
      ],
    },
    endpoints: {
      verifyMcpToken: createAuthEndpoint.serverOnly(
        { method: "POST", body: VerifyBody },
        async (ctx): Promise<McpGrant | null> => {
          const provider = ctx.context.options.plugins?.find((p) => p.id === "oauth-provider");
          const options = provider?.options as OAuthOptions<Scope[]> | undefined;
          if (!options) throw new Error("mcp-access needs the OAuth provider registered.");
          let payload;
          try {
            payload = await getOAuthProviderApi(ctx, options).requireActiveAccessToken(
              ctx.body.token,
            );
          } catch {
            return null;
          }
          // A DPoP-bound token is only safe with its proof checked, which the
          // bearer gate does not do; refusing it keeps every token a bearer one.
          if (
            payload.cnf !== undefined ||
            typeof payload.sub !== "string" ||
            typeof payload.client_id !== "string" ||
            typeof payload.exp !== "number"
          ) {
            return null;
          }
          return {
            userId: payload.sub,
            clientId: payload.client_id,
            scopes:
              typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
            audience: audienceOf(payload.aud),
            expiresAt: payload.exp,
          };
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
