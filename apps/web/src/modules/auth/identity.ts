export interface SessionIdentity {
  userId: string;
  impersonatedBy: string | null;
}

export function projectSessionIdentity(
  session: {
    user: { id: string };
    session: { impersonatedBy?: string | null | undefined };
  } | null,
): SessionIdentity | null {
  return session
    ? { userId: session.user.id, impersonatedBy: session.session.impersonatedBy ?? null }
    : null;
}

export function sameIdentity(a: SessionIdentity | null, b: SessionIdentity | null) {
  return a?.userId === b?.userId && a?.impersonatedBy === b?.impersonatedBy;
}

/**
 * Whether a failed request means the session is gone, as opposed to the
 * network or the server being unwell.
 *
 * The Start client turns a non-OK server-function response into
 * `new Error(await response.text())`, so the status is lost and the body is
 * all that survives. `requireSession` therefore writes a fixed body and this
 * matches on it — the two are one contract. Raw `Response` objects are
 * matched too for callers that fetch API routes directly.
 */
export const UNAUTHENTICATED_BODY = "Unauthorized";
export function isUnauthenticatedError(error: unknown): boolean {
  if (error instanceof Response) return error.status === 401;
  return error instanceof Error && error.message === UNAUTHENTICATED_BODY;
}
