import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { safeRedirect } from "~/modules/auth/redirect.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { appOrigin } from "~/modules/integrations/server/functions.ts";
import {
  callbackPath,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
} from "~/modules/integrations/server/oauth.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { runtime } from "~/server/runtime.ts";

const settings = (integrationId: string, search: Record<string, string>) =>
  `/settings/integrations/${encodeURIComponent(integrationId)}?${new URLSearchParams(search).toString()}`;

/**
 * Starts an OAuth connection in whatever browser opened it. The desktop app
 * sends this URL to the system browser, which therefore has to be signed in
 * here as the same person: the state is bound to this session and a cookie.
 */
export const Route = createFileRoute("/api/integrations/$integrationId/connect")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const current = await sessionFromHeaders(request.headers);
        if (!current?.approved) {
          const back = new URL(request.url).pathname;
          return Response.redirect(
            new URL(`/login?redirect=${encodeURIComponent(back)}`, request.url),
            302,
          );
        }
        const origin = appOrigin(request) ?? new URL(request.url).origin;
        // Only a path on this app; anything else would turn the flow into a redirector.
        const returnTo = safeRedirect(new URL(request.url).searchParams.get("returnTo"));
        const started = await runtime.runPromise(
          Effect.flatMap(IntegrationService, (service) =>
            service.beginOAuth(current.session.user.id, params.integrationId, origin, returnTo),
          ).pipe(
            Effect.map((value) => ({ ok: true as const, ...value })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                error:
                  "reason" in error ? error.reason : "That integration is not available to you.",
              }),
            ),
          ),
        );
        if (!started.ok)
          return new Response(null, {
            status: 302,
            headers: {
              location: settings(params.integrationId, { error: started.error }),
            },
          });
        const secure = origin.startsWith("https:") ? "; Secure" : "";
        return new Response(null, {
          status: 302,
          headers: {
            location: started.url,
            "set-cookie": `${OAUTH_STATE_COOKIE}=${started.state}; Path=${callbackPath(params.integrationId)}; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_MS / 1000}${secure}`,
          },
        });
      },
    },
  },
});
