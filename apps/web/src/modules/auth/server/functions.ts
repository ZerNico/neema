import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { runServerFn } from "~/server/run-server-fn.ts";
import { projectSessionIdentity } from "../identity.ts";
import { currentAuth } from "./auth.ts";
import { SignupRepo } from "./signup-repo.ts";

/**
 * Who is asking, from one uncached session read: the user, the identity the
 * client pins, and whether the account may use the app. Null when signed out.
 * Deliberately outside `requireSession`, since a waiting account has to learn
 * that it is waiting. Never the session record itself: that carries the raw
 * token, and this result is cached client-side and dehydrated into the SSR
 * document.
 */
export const getMe = createServerFn({ method: "GET" }).handler(async () => {
  const session = await (
    await currentAuth()
  ).api.getSession({
    headers: getRequestHeaders(),
    query: { disableCookieCache: true },
  });
  const identity = projectSessionIdentity(session);
  if (!session || !identity) return null;
  const approval = await runServerFn(
    Effect.flatMap(SignupRepo, (repo) => repo.statusOf(session.user.id)),
  );
  return { user: session.user, identity, approval: approval ?? "pending" };
});
