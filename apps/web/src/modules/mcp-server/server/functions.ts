import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { currentAuth, mayConnectApps, mcpResource } from "~/modules/auth/server/auth.ts";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { isMcpScope, OFFLINE_ACCESS } from "../scopes.ts";
import { ConnectedApps } from "./connected-apps.ts";

const standard = Schema.toStandardSchemaV1;

const isImpersonated = (session: object) =>
  "impersonatedBy" in session && Boolean(session.impersonatedBy);

const hostOf = (value: string | null) => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
};

/**
 * The consent request behind the page's own query, which the authorization
 * server signed. Anything else in the URL is ignored: an edited query fails
 * the signature and the page offers nothing to accept.
 */
export const getConsentRequest = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ query: Schema.String })))
  .handler(async ({ data, context }) => {
    const { session, user } = context.session;
    if (isImpersonated(session)) return { state: "impersonating" as const };
    const auth = await currentAuth();
    if (!(await verifyOAuthQueryParams(data.query, (await auth.$context).secret))) {
      return { state: "invalid" as const };
    }
    if (!(await mayConnectApps(user.id))) return { state: "not-allowed" as const };
    const params = new URLSearchParams(data.query);
    const client = await runtime.runPromise(
      ConnectedApps.use((apps) => apps.client(params.get("client_id") ?? "")),
    );
    if (!client) return { state: "invalid" as const };
    const requested = params.get("scope")?.split(" ").filter(Boolean) ?? client.scopes;
    return {
      state: "ready" as const,
      client,
      redirectHost: hostOf(params.get("redirect_uri")),
      scopes: requested.filter(isMcpScope),
      offline: requested.includes(OFFLINE_ACCESS),
    };
  });

export const listConnectedApps = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const userId = context.session.user.id;
    const [apps, allowed] = await Promise.all([
      runtime.runPromise(ConnectedApps.use((service) => service.list(userId))),
      mayConnectApps(userId),
    ]);
    return { apps, allowed, serverUrl: mcpResource() ?? null };
  });

export const revokeConnectedApp = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ clientId: Schema.String })))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ConnectedApps.use((apps) => apps.revoke(context.session.user.id, data.clientId)).pipe(
        Effect.as({ ok: true as const }),
      ),
    ),
  );
