import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { safeRedirect } from "~/modules/auth/redirect.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { oauthCookies } from "~/modules/integrations/server/oauth.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { runtime } from "~/server/runtime.ts";
import { reportFailure, settingsPath, signInCookie, withSearch } from "./-sign-in.ts";

const readCookie = (header: string | null, name: string) => {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

const BACK_COOKIE = "integration_oauth_back_";

/**
 * This sign-in's cookies: named by its state, or, for a service that answers
 * a refusal without one, the one sign-in under way in this browser if there
 * is only one, so its window still lands where it asked.
 */
const cookiesOf = (state: string | null, header: string | null) => {
  if (state) return oauthCookies(state);
  const backs = (header?.split(";") ?? [])
    .map((part) => part.trim().split("=")[0]!)
    .filter((name) => name.startsWith(BACK_COOKIE));
  if (backs.length !== 1) return null;
  const tag = backs[0]!.slice(BACK_COOKIE.length);
  return { state: `integration_oauth_${tag}`, back: backs[0]! };
};

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/** Finishes the flow `connect` started, in the same browser and session. */
export const Route = createFileRoute("/api/integrations/$integrationId/callback")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const cookieHeader = request.headers.get("cookie");
        const names = cookiesOf(state, cookieHeader);
        const back = names ? readCookie(cookieHeader, names.back) : null;
        // Where the outcome is shown: the page the sign-in asked for, else Settings.
        const returnTo = back ? safeRedirect(decoded(back)) : undefined;
        const secure = url.protocol === "https:";
        const finish = (location: string) => {
          const headers = new Headers({ location });
          for (const name of names ? [names.state, names.back] : [])
            headers.append("set-cookie", signInCookie(params.integrationId, name, "", secure));
          return new Response(null, { status: 302, headers });
        };
        // Read here, in the request: the effect below runs on fibers that do not carry it.
        const locale = getLocale();
        const current = await sessionFromHeaders(request.headers);
        const failed = async (error: string) => {
          if (current) await reportFailure(current.session.user.id, returnTo, error);
          return finish(withSearch(returnTo ?? settingsPath(params.integrationId), { error }));
        };
        if (!current?.approved) return failed(m.integrations_sign_in_here_first());
        if (!code || !state)
          return failed(
            url.searchParams.get("error") === "access_denied"
              ? m.integrations_sign_in_cancelled()
              : m.integrations_sign_in_unfinished(),
          );
        const result = await runtime.runPromise(
          Effect.flatMap(IntegrationService, (service) =>
            service.completeOAuth(current.session.user.id, params.integrationId, {
              code,
              state,
              cookieState: names ? readCookie(cookieHeader, names.state) : null,
              // RFC 9207: who answered, checked against who was asked before the code is spent.
              iss: url.searchParams.get("iss"),
            }),
          ).pipe(
            Effect.map((done) => ({ ok: true as const, returnTo: done.returnTo })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                error:
                  "reason" in error
                    ? error.reason(locale)
                    : m.integrations_sign_in_not_available({}, { locale }),
              }),
            ),
          ),
        );
        if (!result.ok) return failed(result.error);
        // Started from a chat or a window of its own: go back there, where the new tools now show.
        const landing = safeRedirect(result.returnTo);
        return finish(
          landing ?? withSearch(settingsPath(params.integrationId), { connected: "1" }),
        );
      },
    },
  },
});
