import { Effect } from "effect";
import { callbackPath, OAUTH_STATE_TTL_MS } from "~/modules/integrations/server/oauth.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { runtime } from "~/server/runtime.ts";

/** What `connect` and `callback` share about where a sign-in lands and what it leaves behind. */
export const settingsPath = (integrationId: string) =>
  `/settings/integrations/${encodeURIComponent(integrationId)}`;

export const withSearch = (path: string, search: Record<string, string>) =>
  `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams(search).toString()}`;

/** A sign-in cookie, only the callback receiving it; empty clears it. */
export const signInCookie = (integrationId: string, name: string, value: string, secure: boolean) =>
  `${name}=${value}; Path=${callbackPath(integrationId)}; HttpOnly; SameSite=Lax; Max-Age=${value ? OAUTH_STATE_TTL_MS / 1000 : 0}${secure ? "; Secure" : ""}`;

/**
 * Tells the app a sign-in in a window of its own failed: that window may be
 * the system browser, which no channel of the app's reaches. Only for a
 * landing that names its attempt, the dialog's random handle.
 */
export const reportFailure = (userId: string, landing: string | undefined, error: string) => {
  if (!landing) return Promise.resolve();
  const attempt = new URL(landing, "http://relative.invalid").searchParams.get("attempt");
  if (!attempt) return Promise.resolve();
  return runtime.runPromise(
    Effect.flatMap(SyncBus, (bus) =>
      bus.publish(userId, { type: "integration.signIn.failed", attempt, error }),
    ).pipe(Effect.catchCause(() => Effect.void)),
  );
};
