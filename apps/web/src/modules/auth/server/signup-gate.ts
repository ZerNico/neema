import { Effect } from "effect";
import type { SignupGate } from "./config.ts";
import { passwordLoginForced, verificationRequired } from "./password-login.ts";
import { OAuthRepo } from "./oauth-repo.ts";
import { SignupRepo } from "./signup-repo.ts";
import { accountEligible } from "./account-eligibility.ts";
import { Db } from "~/server/db.ts";
import { emailDomain, type AuthSettings, type SignupMode } from "../signup.ts";

type Run = <A>(effect: Effect.Effect<A, never, OAuthRepo | SignupRepo | Db>) => Promise<A>;

/**
 * One new account through one way in. A listed domain admits only a verified
 * address: an unverified one is whatever the person typed. A password signup
 * is never verified yet, so with verification required a listed domain gets
 * the account created and waiting, and proving the address lets it in.
 */
const decideAdmission = ({
  mode,
  verified,
  password,
  settings,
  email,
}: {
  mode: SignupMode;
  verified: boolean;
  password: boolean;
  settings: AuthSettings;
  email: string;
}) => {
  const domain = emailDomain(email);
  const listed = domain !== null && settings.admitDomains.includes(domain);
  const domainAdmits = listed && verified;
  const awaitsProof = listed && password && verificationRequired(settings);
  return {
    allowed: mode !== "closed" || domainAdmits || awaitsProof,
    approved: mode === "open" || domainAdmits,
  };
};

// A provider that is gone or switched off mid-redirect counts as closed, which
// still lets a listed domain in.
const admissionFor = (providerId: string | null, email: string, emailVerified: boolean) =>
  Effect.gen(function* () {
    const settings = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
    const provider = providerId
      ? yield* Effect.flatMap(OAuthRepo, (repo) => repo.admission(providerId))
      : null;
    const mode = providerId ? (provider?.signup ?? "closed") : settings.passwordSignup;
    const verified = emailVerified || (provider?.trustEmails ?? false);
    return {
      verified,
      ...decideAdmission({ mode, verified, password: providerId === null, settings, email }),
    };
  });

/**
 * Unlike the provider list, none of this is baked into the auth instance: the
 * settings and a provider's mode are read on the creation they govern, so
 * changing either takes effect on the next signup rather than the next
 * rebuild. Takes its runner so the same rules apply in tests.
 */
export const makeSignupGate = (run: Run): SignupGate => ({
  admit: ({ providerId, email, emailVerified }) =>
    run(
      Effect.gen(function* () {
        // The first account is the owner's, whatever is stored.
        if (yield* Effect.flatMap(SignupRepo, (repo) => repo.needsSetup()))
          return { allowed: true, emailVerified };
        const { allowed, verified } = yield* admissionFor(providerId, email, emailVerified);
        return { allowed, emailVerified: verified };
      }),
    ),

  record: ({ userId, providerId, email, emailVerified, isFirstUser }) =>
    run(
      Effect.gen(function* () {
        // The first account has nobody to approve it.
        const approved =
          isFirstUser || (yield* admissionFor(providerId, email, emailVerified)).approved;
        yield* Effect.flatMap(SignupRepo, (repo) =>
          repo.record({ userId, status: approved ? "approved" : "pending" }),
        );
      }),
    ),

  verified: (account) => run(Effect.flatMap(SignupRepo, (repo) => repo.admitVerified(account))),

  passwordAllowed: () =>
    passwordLoginForced()
      ? Promise.resolve(true)
      : run(
          Effect.gen(function* () {
            const signups = yield* SignupRepo;
            // Setup creates the first account with a password, whatever is stored.
            return (yield* signups.settings()).passwordLogin || (yield* signups.needsSetup());
          }),
        ),

  approved: (userId) => run(accountEligible(userId)),
});
