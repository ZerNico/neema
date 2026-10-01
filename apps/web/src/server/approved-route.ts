import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";

/**
 * The session of a signed-in, approved account, or null. One still waiting on
 * approval is declined as though signed out: only a server function can say
 * why, and the app route is already sending the browser to the waiting screen.
 */
export const approvedSession = async (request: Request) => {
  const current = await sessionFromHeaders(request.headers);
  return current?.approved ? current.session : null;
};

export const unauthorized = () => new Response("Unauthorized", { status: 401 });
