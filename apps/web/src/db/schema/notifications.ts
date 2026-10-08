import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

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
 * One browser that receives this person's notifications while closed. An
 * endpoint belongs to one browser profile, so subscribing it again under
 * another account moves it there.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    /** What the person sees in the device list, from the subscribing browser. */
    label: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
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

/** No row means the defaults: email off, since nobody asked for mail. */
export const notificationSettings = pgTable("notification_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  email: boolean().notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
