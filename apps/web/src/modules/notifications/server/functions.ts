import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { MailService, SmtpSettingsInput } from "./mail.ts";
import { PushService } from "./push.ts";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const PushSubscriptionInput = Schema.Struct({
  endpoint: Text(2048),
  p256dh: Text(200),
  auth: Text(100),
  label: Text(200),
});
const EndpointInput = Schema.Struct({ endpoint: Text(2048) });
const DeviceInput = Schema.Struct({ id: Text(128) });

export const getPushKey = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runtime.runPromise(Effect.flatMap(PushService, (push) => push.publicKey)));

export const subscribePush = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushSubscriptionInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) => push.subscribe(context.session.user.id, data)).pipe(
        Effect.catchTag("PushRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

export const unsubscribePush = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(EndpointInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) =>
        push.unsubscribe(context.session.user.id, data.endpoint),
      ),
    ),
  );

export const listPushDevices = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(Effect.flatMap(PushService, (push) => push.list(context.session.user.id))),
  );

export const removePushDevice = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DeviceInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) => push.remove(context.session.user.id, data.id)),
    ),
  );

export const getNotificationPreferences = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.flatMap(MailService, (mail) => mail.preferences(context.session.user.id)),
    ),
  );

export const setEmailNotifications = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ email: Schema.Boolean })))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(MailService, (mail) => mail.setEmail(context.session.user.id, data.email)),
    ),
  );

export const getSmtpSettings = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(Effect.flatMap(MailService, (mail) => mail.settings)));

export const saveSmtpSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(SmtpSettingsInput))
  .handler(({ data }) =>
    runtime.runPromise(Effect.flatMap(MailService, (mail) => mail.save(data))),
  );

export const clearSmtpSettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(() => runtime.runPromise(Effect.flatMap(MailService, (mail) => mail.clear)));

/** Mails the admin who asked, with what is saved now. */
export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.flatMap(MailService, (mail) => mail.test(context.session.user.email)).pipe(
        Effect.catchTag("MailFailed", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );
