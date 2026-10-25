import { Schema } from "effect";
import type { SignInProvider } from "./oauth.ts";
import { m } from "~/paraglide/messages.js";

/**
 * How one way in admits a new account: email and password has a mode, and so
 * does every OAuth provider. `approval` still creates the account; it just
 * cannot be used until an admin says so, which is what lets an OAuth redirect
 * complete without a decision.
 */
export const SIGNUP_MODES = ["open", "approval", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];
export const SignupModeSchema = Schema.Literals(SIGNUP_MODES);

/** Read where shown, in the reader's language. */
export const SIGNUP_MODE_LABELS: Record<SignupMode, { title: string; description: string }> = {
  open: {
    get title() {
      return m.auth_signup_open_title();
    },
    get description() {
      return m.auth_signup_open_description();
    },
  },
  approval: {
    get title() {
      return m.auth_signup_approval_title();
    },
    get description() {
      return m.auth_signup_approval_description();
    },
  },
  closed: {
    get title() {
      return m.auth_signup_closed_title();
    },
    get description() {
      return m.auth_signup_closed_description();
    },
  },
};

/** For a select: the value with its title. */
export const signupModeItems = () =>
  SIGNUP_MODES.map((value) => ({ value, label: SIGNUP_MODE_LABELS[value].title }));

export interface AuthSettings {
  readonly passwordSignup: SignupMode;
  readonly passwordLogin: boolean;
  readonly requireEmailVerification: boolean;
  readonly admitDomains: readonly string[];
}

/** What the admin page needs beside the settings themselves. */
export interface AuthSettingsView extends AuthSettings {
  /** Verification and password reset both send mail. */
  readonly smtpConfigured: boolean;
  /** `AUTH_PASSWORD_LOGIN=force`: the operator's way back in, beyond the setting. */
  readonly passwordLoginForced: boolean;
  /** Whether addresses must be proven now: the setting, unless the override lifts it. */
  readonly verificationRequired: boolean;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const Domain = Schema.String.check(
  Schema.isPattern(DOMAIN, { message: "Enter a domain such as example.com." }),
);

/** The domain someone typed or pasted, lowercased; an address yields its domain. Null if neither. */
export const parseDomain = (raw: string) => {
  const text = raw.trim().toLowerCase();
  const domain = text.slice(text.lastIndexOf("@") + 1);
  return DOMAIN.test(domain) ? domain : null;
};

/** Enough for any one organisation; the list is matched on every signup. */
export const MAX_ADMIT_DOMAINS = 100;

export const SaveAuthSettingsInput = Schema.Struct({
  passwordSignup: SignupModeSchema,
  passwordLogin: Schema.Boolean,
  requireEmailVerification: Schema.Boolean,
  admitDomains: Schema.Array(Domain).check(Schema.isMaxLength(MAX_ADMIT_DOMAINS)),
});

/** The domain of an address, lowercased, or null for something that is not one. */
export const emailDomain = (email: string) => {
  const at = email.lastIndexOf("@");
  return at < 1 ? null : email.slice(at + 1).toLowerCase();
};

/** What a signed-out page offers. Nothing about policy beyond what a button needs. */
export interface SignInOptions {
  readonly passwordLogin: boolean;
  readonly passwordSignup: boolean;
  /** SMTP is set up and passwords are on, so a forgotten one can be reset by email. */
  readonly passwordReset: boolean;
  /** SMTP is set up, so an address can be proven by a link. */
  readonly mail: boolean;
  readonly providers: readonly SignInProvider[];
}

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const DecideApprovalInput = Schema.Struct({
  userId: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.Literals(["approved", "rejected"]),
});

export const MarkEmailVerifiedInput = Schema.Struct({
  userId: Schema.String.check(Schema.isMinLength(1)),
});

/**
 * Refused because the account is waiting or was turned down, not because there
 * is no session. Same contract as `UNAUTHENTICATED_BODY`: the Start client
 * keeps only a failed response's text, so the body is what the client matches.
 */
export const NOT_APPROVED_BODY = "Account not approved";
export const isNotApprovedError = (error: unknown): boolean =>
  error instanceof Error && error.message === NOT_APPROVED_BODY;
