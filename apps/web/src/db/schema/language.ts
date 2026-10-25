import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * The language a person reads the app in. `chosen` is theirs from Settings,
 * null to follow the browser; `browser` is what the browser last asked for, so
 * mail sent with no request behind it, like a schedule's, still reads right.
 */
export const languageSettings = pgTable("language_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  chosen: text(),
  browser: text(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
