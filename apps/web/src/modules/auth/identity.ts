export interface SessionIdentity {
  userId: string;
  impersonatedBy: string | null;
  /** Lets the Devices page mark the row the reader is using. Not part of identity equality. */
  sessionId?: string;
}

export function projectSessionIdentity(
  session: {
    user: { id: string };
    session: { id?: string; impersonatedBy?: string | null | undefined };
  } | null,
): SessionIdentity | null {
  if (!session) return null;
  const identity: SessionIdentity = {
    userId: session.user.id,
    impersonatedBy: session.session.impersonatedBy ?? null,
  };
  if (session.session.id) identity.sessionId = session.session.id;
  return identity;
}

/** Whether an admin is acting as this session's person rather than the person themselves. */
export const isImpersonated = (session: object) =>
  "impersonatedBy" in session && Boolean(session.impersonatedBy);

/**
 * The refusal of anything that would outlast an impersonated session: a key,
 * a linked login, a desktop, a connected app or service, a schedule.
 */
export const IMPERSONATING_BODY = "Stop impersonating first. This would outlast your session.";

export function sameIdentity(a: SessionIdentity | null, b: SessionIdentity | null) {
  return a?.userId === b?.userId && a?.impersonatedBy === b?.impersonatedBy;
}

/**
 * Whether a failed request means the session is gone, as opposed to the
 * network or the server being unwell.
 *
 * A refused server function rejects with `new Error(await response.text())`
 * (`refusals.ts`), so the status is lost and the body is all that survives.
 * `requireSession` therefore writes a fixed body and this matches on it: the
 * two are one contract. Raw `Response` objects are matched too for callers
 * that fetch API routes directly.
 */
export const UNAUTHENTICATED_BODY = "Unauthorized";
export function isUnauthenticatedError(error: unknown): boolean {
  if (error instanceof Response) return error.status === 401;
  return error instanceof Error && error.message === UNAUTHENTICATED_BODY;
}

/**
 * Whose data this device's caches hold. An admin acting as someone is a
 * separate owner from either of them alone.
 */
export const cacheOwnerOf = (identity: SessionIdentity): string =>
  `${identity.userId}:${identity.impersonatedBy ?? ""}`;
