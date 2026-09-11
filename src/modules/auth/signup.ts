import { Schema } from "effect";

/**
 * Who may get an account, instance-wide, whatever route they came in by.
 * `approval` still creates the account; it just cannot be used until an admin
 * says so, which is what lets an OAuth redirect complete without a decision.
 */
export const SIGNUP_POLICIES = ["open", "approval", "closed"] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

export const SIGNUP_POLICY_LABELS: Record<SignupPolicy, { title: string; description: string }> = {
  open: {
    title: "Anyone can join",
    description: "A new account works straight away.",
  },
  approval: {
    title: "Approval required",
    description: "A new account waits until an admin lets it in.",
  },
  closed: {
    title: "Nobody new",
    description: "Registration and first-time sign-in are refused.",
  },
};

export const SetSignupPolicyInput = Schema.Struct({
  policy: Schema.Literals(SIGNUP_POLICIES),
});

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const DecideApprovalInput = Schema.Struct({
  userId: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.Literals(["approved", "rejected"]),
});

/**
 * Refused because the account is waiting or was turned down, not because there
 * is no session. Same contract as `UNAUTHENTICATED_BODY`: the Start client
 * keeps only a failed response's text, so the body is what the client matches.
 */
export const NOT_APPROVED_BODY = "Account not approved";
export function isNotApprovedError(error: unknown): boolean {
  return error instanceof Error && error.message === NOT_APPROVED_BODY;
}
