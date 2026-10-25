import { m } from "~/paraglide/messages.js";

/** Our refusal of a new account, as the OAuth callback forwards it. */
export const SIGNUP_CLOSED = "signup_closed";

/** A password sign-in to an account that only signs in through its provider. */
export const SIGN_IN_WITH_PROVIDER = "sign_in_with_provider";

/** Anything an admin acting as someone may not do, a link among them. */
export const IMPERSONATING = "impersonating";

/**
 * Better Auth returns a failed OAuth sign-in to this URL with an `error` code
 * appended, keeping where the person was headed.
 */
export const loginErrorURL = (callbackURL: string) =>
  callbackURL === "/" ? "/login" : `/login?redirect=${encodeURIComponent(callbackURL)}`;

const MESSAGES: Record<string, () => string> = {
  [SIGNUP_CLOSED]: m.auth_oauth_error_signup_closed,
  [IMPERSONATING]: m.auth_error_impersonating,
  // Better Auth's reason when an account with the address exists but was never
  // proven, so merging into it would hand it to whoever typed the address.
  account_not_linked: m.auth_oauth_error_account_not_linked,
  email_not_found: m.auth_oauth_error_email_not_found,
  email_not_verified: m.auth_oauth_error_email_not_verified,
  account_already_linked_to_different_user: m.auth_oauth_error_linked_elsewhere,
  unable_to_link_account: m.auth_oauth_error_unable_to_link,
};

/** What to tell the person about a failed OAuth round trip. */
export const oauthErrorMessage = (code: string) =>
  (Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : m.auth_oauth_error_generic)();
