import { queryOptions } from "@tanstack/react-query";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { getSessionUser } from "./server/functions.ts";

export const authClient = createAuthClient({
  plugins: [adminClient()],
});

export type SessionData = typeof authClient.$Infer.Session;

/**
 * The signed-in user behind the query cache, because `_app.beforeLoad` runs on
 * every navigation AND every hover preload — uncached, that is a round trip in
 * front of the route's own data on each one, including a switch between two
 * chats already held in the cache.
 *
 * Cleared on sign-out rather than expired: nothing here may outlive the
 * session it was read from.
 */
export const sessionUserQuery = queryOptions({
  queryKey: ["session-user"],
  queryFn: () => getSessionUser(),
  staleTime: 30_000,
});
