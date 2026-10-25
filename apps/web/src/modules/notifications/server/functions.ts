import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { invalidateAuth } from "~/modules/auth/server/auth.ts";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { SignupRepo } from "~/modules/auth/server/signup-repo.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { refuse } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { MailService, SmtpSettingsInput } from "./mail.ts";
import { PushService } from "./push.ts";
import { NotificationService } from "./service.ts";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const PushSubscriptionInput = Schema.Struct({
  endpoint: Text(2048),
  p256dh: Text(200),
  auth: Text(100),
});

export const getPushKey = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runServerFn(Effect.flatMap(PushService, (push) => push.publicKey)));

export const subscribePush = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushSubscriptionInput))
  .handler(({ data, context }) =>
    runServerFn(
      Effect.flatMap(PushService, (push) =>
        push.subscribe(
          { userId: context.session.user.id, sessionId: context.session.session.id },
          data,
        ),
      ),
    ),
  );

export const getNotificationPreferences = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      Effect.flatMap(NotificationService, (service) =>
        service.preferences(context.session.user.id),
      ),
    ),
  );

export const updateNotificationPreferences = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        push: Schema.optionalKey(Schema.Boolean),
        email: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  )
  .handler(({ data, context }) =>
    runServerFn(
      Effect.flatMap(NotificationService, (service) =>
        service.setPreferences(context.session.user.id, data),
      ),
    ),
  );

export const getSmtpSettings = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(Effect.flatMap(MailService, (mail) => mail.settings)));

export const saveSmtpSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(SmtpSettingsInput))
  .handler(async ({ data }) => {
    await runServerFn(Effect.flatMap(MailService, (mail) => mail.save(data)));
    // The auth instance offers password reset and verification only with mail.
    invalidateAuth();
  });

export const clearSmtpSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async () => {
    await runServerFn(
      Effect.gen(function* () {
        const settings = yield* Effect.flatMap(SignupRepo, (repo) => repo.settings());
        // Accounts could no longer prove their address, and nobody new could get in.
        if (settings.requireEmailVerification)
          return yield* refuse(409, localized(m.notifications_error_verification_on));
        yield* Effect.flatMap(MailService, (mail) => mail.clear);
      }),
    );
    invalidateAuth();
  });

/** Mails the admin who asked, with what is saved now. */
export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(({ context }) =>
    runServerFn(
      Effect.flatMap(MailService, (mail) => mail.test(context.session.user.email, getLocale())),
    ),
  );
