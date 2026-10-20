/** Our refusal of a new account, as the OAuth callback forwards it. */
export const SIGNUP_CLOSED = "signup_closed";

/**
 * Better Auth returns a failed OAuth sign-in to this URL with an `error` code
 * appended, keeping where the person was headed.
 */
export const loginErrorURL = (callbackURL: string) =>
  callbackURL === "/" ? "/login" : `/login?redirect=${encodeURIComponent(callbackURL)}`;

const MESSAGES: Record<string, string> = {
  [SIGNUP_CLOSED]: "This sign-in can’t create new accounts here.",
  // Better Auth's reason when an account with the address exists but was never
  // proven, so merging into it would hand it to whoever typed the address.
  account_not_linked:
    "An account with this email already exists. Sign in to it, then connect this sign-in under Settings.",
  email_not_found: "The provider didn’t share an email address.",
  email_not_verified: "The provider hasn’t verified this email address.",
  account_already_linked_to_different_user: "That sign-in already belongs to another account.",
  unable_to_link_account: "That sign-in couldn’t be connected.",
};

/** What to tell the person about a failed OAuth round trip. */
export const oauthErrorMessage = (code: string) =>
  MESSAGES[code] ?? "Sign-in didn’t complete. Try again.";
