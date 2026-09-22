import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * Which feature explanations a person has already been shown. Keys come from
 * the client-side registry (`modules/help/features.ts`); a key added there later
 * has no row yet, which is exactly what makes it show up once as new.
 */
export const userSeenFeatures = pgTable(
  "user_seen_features",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.featureKey] })],
);
