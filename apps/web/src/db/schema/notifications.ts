import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
