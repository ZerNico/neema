import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { meQuery, needsSetupQuery } from "./client.ts";
import { redirectSearch } from "./redirect.ts";

/**
 * The sign-in pages' `beforeLoad`. Someone who already holds a session has
 * nothing to do here, and a `redirect` search that pointed them at the page
 * (the desktop sign-in flow does this) must still be honoured, or the page
 * they wanted sits behind a form they cannot usefully submit.
 */
export async function leaveIfSignedIn(queryClient: QueryClient, redirectTo: string | undefined) {
  const me = await queryClient.ensureQueryData(meQuery);
  if (!me) return;
  if (me.approval !== "approved") throw redirect({ to: "/pending" });
  throw redirect({ href: redirectTo ?? "/" });
}

/** Sign-in and registration have nothing to offer an instance nobody owns yet. */
export async function setUpFirst(queryClient: QueryClient, redirectTo: string | undefined) {
  if (await queryClient.fetchQuery(needsSetupQuery))
    throw redirect({ to: "/setup", search: redirectSearch(redirectTo) });
}
