import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { Auth } from "~/modules/auth/server/auth.ts";
import { authorizeQuery, needsFreshSignIn, packQuery } from "../authorize-query.ts";

/**
 * Where the authorization server sends a browser that has to sign in. Read
 * from the raw request, because the router would re-serialize the query.
 * Redirects are relative so a proxy in front never rewrites their origin.
 */
export async function signInRedirect(request: Request, auth: Auth): Promise<Response> {
  const search = new URL(request.url).search;
  const headers = new Headers({
    location: `/oauth/continue?request=${packQuery(authorizeQuery(search))}`,
  });
  // Only for a query the provider signed: an unsigned link from anywhere
  // would otherwise end the person's session.
  if (
    needsFreshSignIn(search) &&
    (await verifyOAuthQueryParams(search.slice(1), (await auth.$context).secret))
  ) {
    const out = await auth.api.signOut({ headers: request.headers, asResponse: true });
    for (const cookie of out.headers.getSetCookie()) headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}
