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
