/**
 * How a sign-in in a window of its own tells the dialog that opened it how it
 * went. A channel rather than `window.opener`: the service's pages often cut
 * that link (COOP), and a channel reaches any tab of this app in the browser.
 */
const CHANNEL = "integration-sign-in";

export interface SignInOutcome {
  /** The dialog's own id for this sign-in, so another tab's is not taken for it. */
  readonly attempt: string;
  /** Why it did not finish; null when it did. */
  readonly error: string | null;
}

/** Where a sign-in in its own window ends, success or not, carrying its attempt. */
export const signInLanding = (attempt: string) =>
  `/integrations/connected?${new URLSearchParams({ attempt }).toString()}`;

export const announceSignIn = (outcome: SignInOutcome) => {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a channel never leaves this origin and takes none
  channel.postMessage(outcome);
  channel.close();
};

/** Calls back once with this attempt's outcome; the returned function stops listening. */
export const onSignIn = (attempt: string, done: (outcome: SignInOutcome) => void) => {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener("message", (event: MessageEvent<SignInOutcome>) => {
    if (event.data?.attempt === attempt) done(event.data);
  });
  return () => channel.close();
};
