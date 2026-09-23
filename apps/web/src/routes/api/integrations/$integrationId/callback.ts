import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { safeRedirect } from "~/modules/auth/redirect.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { callbackPath, OAUTH_STATE_COOKIE } from "~/modules/integrations/server/oauth.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { runtime } from "~/server/runtime.ts";

const readCookie = (header: string | null, name: string) => {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

/** Finishes the flow `connect` started, in the same browser and session. */
export const Route = createFileRoute("/api/integrations/$integrationId/callback")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const back = (search: Record<string, string>) =>
          new Response(null, {
            status: 302,
            headers: {
              location: `/settings/integrations?${new URLSearchParams({ integration: params.integrationId, ...search }).toString()}`,
              "set-cookie": `${OAUTH_STATE_COOKIE}=; Path=${callbackPath(params.integrationId)}; HttpOnly; SameSite=Lax; Max-Age=0`,
            },
          });
        const current = await sessionFromHeaders(request.headers);
        if (!current?.approved) return back({ error: "Sign in here first, then connect again." });
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state)
          return back({
            error:
              url.searchParams.get("error") === "access_denied"
                ? "The connection was cancelled."
                : "The service did not finish the sign-in.",
          });
        const result = await runtime.runPromise(
          Effect.flatMap(IntegrationService, (service) =>
            service.completeOAuth(current.session.user.id, params.integrationId, {
              code,
              state,
              cookieState: readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE),
            }),
          ).pipe(
            Effect.map(({ returnTo }) => ({ ok: true as const, returnTo })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                error:
                  "reason" in error ? error.reason : "That integration is not available to you.",
              }),
            ),
          ),
        );
        if (!result.ok) return back({ error: result.error });
        // Started from a chat: go back there, where the new tools now show.
        const returnTo = safeRedirect(result.returnTo);
        if (returnTo)
          return new Response(null, {
            status: 302,
            headers: {
              location: returnTo,
              "set-cookie": `${OAUTH_STATE_COOKIE}=; Path=${callbackPath(params.integrationId)}; HttpOnly; SameSite=Lax; Max-Age=0`,
            },
          });
        return back({ connected: "1" });
      },
    },
  },
});
