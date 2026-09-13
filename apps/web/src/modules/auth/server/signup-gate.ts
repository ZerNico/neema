import { Effect } from "effect";
import type { SignupGate } from "./config.ts";
import { OAuthRepo } from "./oauth-repo.ts";
import { SignupRepo } from "./signup-repo.ts";

type Run = <A>(effect: Effect.Effect<A, never, OAuthRepo | SignupRepo>) => Promise<A>;

/**
 * Unlike the provider list, none of this is baked into the auth instance: the
 * policy and a provider's trust are read on the creation they govern, so
 * changing either takes effect on the next signup rather than the next
 * rebuild. Takes its runner so the same rules apply in tests.
 */
export const makeSignupGate = (run: Run): SignupGate => ({
  allow: () =>
    run(Effect.flatMap(SignupRepo, (repo) => Effect.map(repo.policy(), (p) => p !== "closed"))),

  record: ({ userId, providerId, isFirstUser }) =>
    run(
      Effect.gen(function* () {
        const signups = yield* SignupRepo;
        const oauth = yield* OAuthRepo;
        const policy = yield* signups.policy();
        const trusted = providerId ? yield* oauth.isTrusted(providerId) : false;
        // The first account has nobody to approve it, and a trusted provider
        // has already decided who belongs.
        const approved = isFirstUser || policy === "open" || trusted;
        yield* signups.record({ userId, status: approved ? "approved" : "pending" });
      }),
    ),

  // No row means an account created before approvals existed.
  approved: (userId) =>
    run(
      Effect.flatMap(SignupRepo, (repo) =>
        Effect.map(repo.statusOf(userId), (status) => status === null || status === "approved"),
      ),
    ),
});
