import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { meQuery, needsSetupQuery, type Me } from "./client.ts";
import { redirectSearch } from "./redirect.ts";

/**
 * The sign-in pages' `beforeLoad`. Someone who already holds a session has
 * nothing to do here, and a `redirect` search that pointed them at the page
 * (the desktop sign-in flow does this) must still be honoured, or the page
 * they wanted sits behind a form they cannot usefully submit.
 */
export async function leaveIfSignedIn(queryClient: QueryClient, redirectTo: string | undefined) {
  leave(await queryClient.ensureQueryData(meQuery), redirectTo);
}

function leave(me: Me | null, redirectTo: string | undefined) {
  if (!me) return;
  if (me.approval !== "approved") throw redirect({ to: "/pending" });
  throw redirect({ href: redirectTo ?? "/" });
}

/**
 * Sign-in, registration and password reset: setup first, since they have
 * nothing to offer an instance nobody owns yet, then `leaveIfSignedIn`. Both
 * are read at once and decided in that order.
 */
export async function guardSignInPage(queryClient: QueryClient, redirectTo: string | undefined) {
  const [needsSetup, me] = await Promise.all([
    queryClient.fetchQuery(needsSetupQuery),
    queryClient.ensureQueryData(meQuery),
  ]);
  if (needsSetup) throw redirect({ to: "/setup", search: redirectSearch(redirectTo) });
  leave(me, redirectTo);
}
