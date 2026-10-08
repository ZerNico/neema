import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/** No row means the person never changed their pins and gets the defaults. */
export const sidebarPins = pgTable("sidebar_pins", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  pinned: text().array().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
