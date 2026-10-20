import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { createTransport } from "nodemailer";
import { smtpSettings, user } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { Db } from "~/server/db.ts";
import { publicUrl } from "~/server/public-url.ts";
import type { AppNotification } from "../schema.ts";

const SETTINGS_ID = "instance";

export const SmtpSecurity = Schema.Literals(["tls", "starttls", "none"]);
export const SmtpSettingsInput = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  security: SmtpSecurity,
  username: Schema.NullOr(Schema.String.check(Schema.isMaxLength(320))),
  /** Absent keeps the stored password; null clears it. */
  password: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
  fromAddress: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
});
export type SmtpSettingsInput = typeof SmtpSettingsInput.Type;

/** What the admin page shows: everything but the password itself. */
export interface SmtpSettingsView {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string | null;
  passwordSet: boolean;
  fromAddress: string;
}

export class MailFailed extends Schema.TaggedError<MailFailed>()("MailFailed", {
  reason: Schema.String,
}) {}

/**
 * Notification email through the SMTP server an admin set. The host is the
 * admin's choice and may well be an internal relay, so it is not held to the
 * public-address rule that user-supplied URLs are.
 */
export class MailService extends Context.Service<
  MailService,
  {
    readonly settings: Effect.Effect<SmtpSettingsView | null>;
    save(input: SmtpSettingsInput): Effect.Effect<void>;
    clear: Effect.Effect<void>;
    /** Sends one message now and reports the server's refusal. */
    test(to: string): Effect.Effect<void, MailFailed>;
    /** Whether an admin set up a server, so anyone can get email. */
    readonly available: Effect.Effect<boolean>;
    send(userId: string, notification: AppNotification): Effect.Effect<void>;
    /** One message to one address, for mail that is not a notification. */
    sendTo(to: string, subject: string, text: string): Effect.Effect<void, MailFailed>;
  }
>()("chat/notifications/MailService") {
  static readonly layer = Layer.effect(
    MailService,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const row = Effect.map(
        db.select().from(smtpSettings).where(eq(smtpSettings.id, SETTINGS_ID)).pipe(Effect.orDie),
        (rows) => rows[0] ?? null,
      );

      const deliver = (to: string, subject: string, text: string) =>
        Effect.gen(function* () {
          const config = yield* row;
          if (!config) return yield* new MailFailed({ reason: "email is not set up" });
          const password = config.passwordCiphertext
            ? Redacted.value(yield* cipher.decrypt(config.passwordCiphertext))
            : undefined;
          const transport = createTransport({
            host: config.host,
            port: config.port,
            secure: config.security === "tls",
            requireTLS: config.security === "starttls",
            ignoreTLS: config.security === "none",
            ...(config.username ? { auth: { user: config.username, pass: password ?? "" } } : {}),
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 20_000,
          });
          yield* Effect.tryPromise({
            try: () => transport.sendMail({ from: config.fromAddress, to, subject, text }),
            // The server's reply names the problem (auth, relay denied), and
            // the admin testing it needs that, never the password.
            catch: (error) =>
              new MailFailed({
                reason: error instanceof Error ? error.message.slice(0, 300) : "sending failed",
              }),
          }).pipe(Effect.ensuring(Effect.sync(() => transport.close())));
        });

      return MailService.of({
        settings: Effect.map(row, (config) =>
          config
            ? {
                host: config.host,
                port: config.port,
                security: config.security,
                username: config.username,
                passwordSet: config.passwordCiphertext !== null,
                fromAddress: config.fromAddress,
              }
            : null,
        ),
        save: Effect.fn("MailService.save")(function* (input) {
          const { password, ...fields } = input;
          const passwordCiphertext =
            password === undefined
              ? undefined
              : password === null || password === ""
                ? null
                : yield* cipher.encrypt(password);
          yield* db
            .insert(smtpSettings)
            .values({ id: SETTINGS_ID, ...fields, passwordCiphertext: passwordCiphertext ?? null })
            .onConflictDoUpdate({
              target: smtpSettings.id,
              set: {
                ...fields,
                ...(passwordCiphertext !== undefined ? { passwordCiphertext } : {}),
                updatedAt: sql`now()`,
              },
            })
            .pipe(Effect.orDie);
        }),
        clear: db
          .delete(smtpSettings)
          .where(eq(smtpSettings.id, SETTINGS_ID))
          .pipe(Effect.orDie, Effect.asVoid),
        test: (to) =>
          deliver(to, "neema test email", "Email from neema works. Schedules can notify you here."),
        available: Effect.map(row, (config) => config !== null),
        sendTo: deliver,
        send: Effect.fn("MailService.send")(function* (userId, notification) {
          const [recipient] = yield* db
            .select({ address: user.email })
            .from(user)
            .where(eq(user.id, userId))
            .pipe(Effect.orDie);
          if (!recipient) return;
          const site = publicUrl();
          const text = site
            ? `${notification.body}\n\nOpen it: ${site}${notification.path}`
            : notification.body;
          yield* deliver(recipient.address, notification.title, text).pipe(
            Effect.catch((error) =>
              Effect.logWarning("notification email could not be sent", { reason: error.reason }),
            ),
          );
        }),
      });
    }),
  );
}
