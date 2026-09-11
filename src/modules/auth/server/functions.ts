import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { projectSessionIdentity } from "../identity.ts";
import { currentAuth } from "./auth.ts";

/**
 * The signed-in user, or null. Deliberately not the whole session: that record
 * carries the raw session token, and this result is cached client-side and
 * dehydrated into the SSR document, neither of which a bearer token may reach.
 * The route context only ever needed the user anyway.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  const session = await (await currentAuth()).api.getSession({ headers: getRequestHeaders() });
  return session?.user ?? null;
});

export const getSessionIdentity = createServerFn({ method: "GET" }).handler(async () => {
  const session = await (
    await currentAuth()
  ).api.getSession({
    headers: getRequestHeaders(),
    query: { disableCookieCache: true },
  });
  return projectSessionIdentity(session);
});
