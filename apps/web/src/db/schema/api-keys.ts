import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * A person's long-lived key for calling this instance without a browser.
 * Only a SHA-256 of the secret is kept: the secret is 256 random bits, so a
 * fast hash is as strong as a slow one and lets a request find its row.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** The secret's first characters, enough to tell keys apart in a list. */
    start: text().notNull(),
    hash: text().notNull().unique(),
    scopes: text().array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("api_keys_user_idx").on(table.userId)],
);
