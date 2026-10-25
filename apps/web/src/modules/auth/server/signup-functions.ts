import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { MailService } from "~/modules/notifications/server/mail.ts";
import { refuse } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  DecideApprovalInput,
  MarkEmailVerifiedInput,
  SaveAuthSettingsInput,
  type AuthSettingsView,
  type SignInOptions,
} from "../signup.ts";
import { invalidateAuth } from "./auth.ts";
import { passwordLoginForced, verificationRequired } from "./password-login.ts";
import { requireAdmin } from "./middleware.ts";
import { OAuthRepo } from "./oauth-repo.ts";
import { SignupRepo } from "./signup-repo.ts";
import { requireWayIn } from "./way-in.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

const standard = Schema.toStandardSchemaV1;

/** Public: a signed-out visitor has to know whether to set up or sign in. */
export const getNeedsSetup = createServerFn({ method: "GET" }).handler(() =>
  runServerFn(Effect.flatMap(SignupRepo, (repo) => repo.needsSetup())),
);

/**
 * Public: a signed-out page has to know which ways in to offer. A closed
 * provider still signs existing accounts in, so only registration hides it.
 */
export const getSignInOptions = createServerFn({ method: "GET" }).handler(() =>
  runServerFn(
    Effect.gen(function* () {
      const settings = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
      const mail = yield* Effect.flatMap(MailService, (service) => service.available);
      const providers = yield* Effect.flatMap(OAuthRepo, (repo) => repo.listForSignIn());
      const passwordLogin = settings.passwordLogin || passwordLoginForced();
      // A listed domain joins through any provider, and through a password it then proves.
      const domains = settings.admitDomains.length > 0;
      const domainProof = verificationRequired(settings) && domains;
      return {
        passwordLogin,
        passwordSignup: passwordLogin && (settings.passwordSignup !== "closed" || domainProof),
        passwordReset: passwordLogin && mail,
        mail,
        providers: providers.map((p) => ({
          id: p.id,
          label: p.label,
          signup: p.signup !== "closed" || domains,
          exclusive: p.exclusive,
        })),
      } satisfies SignInOptions;
    }),
  ),
);

export const getAuthSettings = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      Effect.gen(function* () {
        const settings = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
        const smtpConfigured = yield* Effect.flatMap(MailService, (mail) => mail.available);
        return {
          ...settings,
          smtpConfigured,
          passwordLoginForced: passwordLoginForced(),
          verificationRequired: verificationRequired(settings),
        } satisfies AuthSettingsView;
      }),
    ),
  );

/**
 * Turning password sign-in off is refused to an admin it would lock out, as
 * switching off a provider and unlinking are. The operator's way back beyond
 * that is `AUTH_PASSWORD_LOGIN=force`.
 */
export const saveAuthSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveAuthSettingsInput))
  .handler(async ({ data, context }) => {
    await runServerFn(
      Effect.gen(function* () {
        const current = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
        if (data.requireEmailVerification && !current.requireEmailVerification) {
          const mail = yield* Effect.flatMap(MailService, (service) => service.available);
          if (!mail) return yield* refuse(409, localized(m.auth_error_email_needed));
          // Proving your own address first also proves the mail server delivers.
          if (!context.session.user.emailVerified)
            return yield* refuse(409, localized(m.auth_error_verify_own));
        }
        if (current.passwordLogin && !data.passwordLogin)
          yield* requireWayIn(context.session.user.id, { passwordLogin: false });
        yield* Effect.flatMap(SignupRepo, (repo) => repo.saveSettings(data));
      }),
    );
    // Verification is baked into the auth instance.
    invalidateAuth();
  });

export const markEmailVerified = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(MarkEmailVerifiedInput))
  .handler(({ data }) =>
    runServerFn(Effect.flatMap(SignupRepo, (repo) => repo.markVerified(data.userId))),
  );

export const listPendingAccounts = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(Effect.flatMap(SignupRepo, (repo) => repo.listPending())));

/**
 * A rejected account is kept rather than deleted: deleting it would let the
 * same person sign up again and reappear in the queue, which is the one thing
 * rejecting them was meant to stop.
 */
export const decideAccount = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(DecideApprovalInput))
  .handler(({ data, context }) =>
    runServerFn(
      Effect.flatMap(SignupRepo, (repo) =>
        repo.decide({
          userId: data.userId,
          status: data.status,
          decidedBy: context.session.user.id,
        }),
      ).pipe(
        Effect.flatMap((decided) =>
          decided ? Effect.void : refuse(409, localized(m.auth_error_decide_self)),
        ),
      ),
    ),
  );
