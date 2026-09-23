import { queryOptions } from "@tanstack/react-query";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { getSessionUser, getSessionIdentity } from "./server/functions.ts";
import { getApprovalStatus } from "./server/signup-functions.ts";

export const authClient = createAuthClient({
  plugins: [adminClient()],
});

export type SessionData = typeof authClient.$Infer.Session;

/**
 * The signed-in user behind the query cache, because `_app.beforeLoad` runs on
 * every navigation AND every hover preload. Uncached, that is a round trip in
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

export const sessionIdentityQuery = queryOptions({
  queryKey: ["session-identity"],
  queryFn: () => getSessionIdentity(),
  staleTime: 30_000,
});

/**
 * Whether this account may use the app. Not folded into `sessionUserQuery`
 * because approval changes independently, and a user held there for a week must
 * not keep a week-old answer.
 */
export const approvalStatusQuery = queryOptions({
  queryKey: ["approval-status"],
  queryFn: () => getApprovalStatus(),
  staleTime: 30_000,
});

/**
 * Desktop sign-in endpoints, reached through `$fetch` so the cookies plugin,
 * origin check and rate limiter apply as they do to every other auth call.
 * Each resolves to the body or throws the server's message, which the pages
 * show verbatim.
 */
type DesktopFetch<T> = Promise<{ data: T | null; error: { message?: string } | null }>;

const unwrap = async <T>(call: DesktopFetch<T>): Promise<T> => {
  const { data, error } = await call;
  if (error || data === null) throw new Error(error?.message ?? "Something went wrong.");
  return data;
};

export interface DesktopTicket {
  ticket: string;
  /** Random handle the sync event names on redemption; not derived from the code. */
  ticketId: string;
  expiresAt: string;
}

/** Mints a ticket for the signed-in browser user; omit `challenge` for a paste-only code. */
export const createDesktopTicket = (input: { challenge?: string } = {}) =>
  unwrap(authClient.$fetch<DesktopTicket>("/desktop/ticket", { method: "POST", body: input }));

/** Trades a ticket for a new desktop session; the cookie arrives on the response. */
export const redeemDesktopTicket = (input: { ticket: string; verifier?: string }) =>
  unwrap(authClient.$fetch<{ ok: true }>("/desktop/session", { method: "POST", body: input }));

/** Extends the current desktop session to a fresh 90 days; the server refuses browsers. */
export const refreshDesktopSession = () =>
  unwrap(
    authClient.$fetch<{ ok: true; expiresAt: string }>("/desktop/session/refresh", {
      method: "POST",
    }),
  );

/** One signed-in device, as `/desktop/devices` reports it: never the session token. */
export interface DesktopSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  current: boolean;
}

export const desktopSessionsQuery = queryOptions({
  queryKey: ["desktop-sessions"],
  queryFn: () => unwrap(authClient.$fetch<DesktopSession[]>("/desktop/devices", { method: "GET" })),
  staleTime: 30_000,
});

/** Signs out one other device by session id; an id that is not ours is a silent no-op. */
export const revokeDesktopDevice = (input: { id: string }) =>
  unwrap(
    authClient.$fetch<{ ok: true }>("/desktop/devices/revoke", { method: "POST", body: input }),
  );
