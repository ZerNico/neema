import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { approvalStatusQuery, sessionUserQuery } from "./client.ts";

/**
 * The sign-in pages' `beforeLoad`. Someone who already holds a session has
 * nothing to do here, and a `redirect` search that pointed them at the page
 * (the desktop sign-in flow does this) must still be honoured, or the page
 * they wanted sits behind a form they cannot usefully submit.
 */
export async function leaveIfSignedIn(queryClient: QueryClient, redirectTo: string | undefined) {
  const user = await queryClient.ensureQueryData(sessionUserQuery);
  if (!user) return;
  const approval = await queryClient.ensureQueryData(approvalStatusQuery);
  if (approval !== "approved") throw redirect({ to: "/pending" });
  throw redirect({ href: redirectTo ?? "/" });
}
