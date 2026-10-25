import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { IMPERSONATING_BODY, isImpersonated } from "~/modules/auth/identity.ts";
import { safeRedirect } from "~/modules/auth/redirect.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { appOrigin } from "~/modules/integrations/server/functions.ts";
import { oauthCookies } from "~/modules/integrations/server/oauth.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { runtime } from "~/server/runtime.ts";
import { reportFailure, settingsPath, signInCookie, withSearch } from "./-sign-in.ts";

/**
 * Starts an OAuth connection in whatever browser opened it. The desktop app
 * sends this URL to the system browser, which therefore has to be signed in
 * here as the same person (`as` says who): the state is bound to this session
 * and a cookie.
 */
export const Route = createFileRoute("/api/integrations/$integrationId/connect")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const current = await sessionFromHeaders(request.headers);
        if (!current?.approved) {
          // All of it, so the sign-in comes back to this same request: who asked included.
          const back = `${url.pathname}${url.search}`;
          return Response.redirect(
            new URL(`/login?redirect=${encodeURIComponent(back)}`, request.url),
            302,
          );
        }
        const origin = appOrigin(request) ?? url.origin;
        // Only a path on this app; anything else would turn the flow into a redirector.
        const returnTo = safeRedirect(url.searchParams.get("returnTo"));
        // An account to reconnect; the service checks it is this person's own.
        const connectionId = url.searchParams.get("account") ?? undefined;
        const failed = async (error: string, tell: string) => {
          await reportFailure(tell, returnTo, error);
          return new Response(null, {
            status: 302,
            headers: {
              location: withSearch(returnTo ?? settingsPath(params.integrationId), { error }),
            },
          });
        };
        // The desktop app signs in in the system browser, which may hold someone
        // else's session here: their account would land with them, not the asker.
        // So every link names who asked, and one that names nobody starts nothing.
        // A connection outlasts the session: an admin acting as someone makes none.
        if (isImpersonated(current.session.session))
          return failed(IMPERSONATING_BODY, current.session.user.id);
        const asked = url.searchParams.get("as");
        if (asked !== current.session.user.id)
          return failed(
            asked
              ? "This browser is signed in here as someone else. Sign in as yourself, then try again."
              : "Start connecting again from the app.",
            asked ?? current.session.user.id,
          );
        const started = await runtime.runPromise(
          Effect.flatMap(IntegrationService, (service) =>
            service.beginOAuth(
              current.session.user.id,
              params.integrationId,
              origin,
              returnTo,
              connectionId,
            ),
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
        if (!started.ok) return failed(started.error, current.session.user.id);
        const secure = origin.startsWith("https:");
        const names = oauthCookies(started.state);
        const headers = new Headers({ location: started.url });
        headers.append(
          "set-cookie",
          signInCookie(params.integrationId, names.state, started.state, secure),
        );
        // Where a failure is shown too: a sign-in in its own window ends on the page that
        // tells the window that opened it, whatever happened.
        if (returnTo)
          headers.append(
            "set-cookie",
            signInCookie(params.integrationId, names.back, encodeURIComponent(returnTo), secure),
          );
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
