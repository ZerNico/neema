import { authorizeQuery, needsFreshSignIn, packQuery } from "../authorize-query.ts";

/**
 * Where the authorization server sends a browser that has to sign in. Read
 * from the raw request, because the router would re-serialize the query.
 * Redirects are relative so a proxy in front never rewrites their origin.
 *
 * A request for a newer sign-in only marks it: this is a plain GET any site
 * can link to, so it never ends a session. The person does, from the page.
 */
export function signInRedirect(request: Request): Response {
  const search = new URL(request.url).search;
  const fresh = needsFreshSignIn(search) ? "&fresh=1" : "";
  return new Response(null, {
    status: 302,
    headers: { location: `/oauth/continue?request=${packQuery(authorizeQuery(search))}${fresh}` },
  });
}
