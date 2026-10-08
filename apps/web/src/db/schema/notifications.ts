import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { session, user } from "./auth.ts";

/**
 * This server's Web Push identity, made on first need. Browsers subscribe
 * against the public key, so replacing it silently orphans every
 * subscription; the private half is encrypted like any stored credential.
 */
export const pushKeys = pgTable("push_keys", {
  id: text().primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKeyCiphertext: text("private_key_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One browser that receives this person's notifications while closed. It
 * belongs to the sign-in that subscribed it, so signing out, or revoking that
 * device, stops it. An endpoint is one browser profile: subscribing it again
 * under another sign-in moves it there.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("push_subscriptions_user_idx").on(t.userId),
    index("push_subscriptions_session_idx").on(t.sessionId),
  ],
);

/**
 * The instance's outgoing mail, set by an admin. One row; none means no email
 * channel. The password is a credential like any provider key.
 */
export const smtpSettings = pgTable("smtp_settings", {
  id: text().primaryKey(),
  host: text().notNull(),
  port: integer().notNull(),
  /** `tls` from the first byte (465), `starttls` upgrades (587), `none` for a local relay. */
  security: text({ enum: ["tls", "starttls", "none"] }).notNull(),
  username: text(),
  passwordCiphertext: text("password_ciphertext"),
  fromAddress: text("from_address").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Where schedule runs reach this person, the one kind of notification so far.
 * No row means the defaults: push on, email off since nobody asked for mail.
 */
export const notificationSettings = pgTable("notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  push: boolean().notNull().default(true),
  email: boolean().notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
