import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// Who may get an account, and who already has one. Approval lives here rather
// than on `user` because Better Auth owns that table's columns and a future
// release adding its own status field would collide.

export const authSettings = pgTable("auth_settings", {
  // One row, seeded by migration. The constant primary key is what keeps it
  // one row: a second insert conflicts instead of creating a rival policy.
  id: text().primaryKey(),
  // "open" admits anyone, "approval" queues them, "closed" refuses creation.
  signupPolicy: text("signup_policy").$type<"open" | "approval" | "closed">().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const AUTH_SETTINGS_ID = "instance";

export const userApprovals = pgTable("user_approvals", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text().$type<"pending" | "approved" | "rejected">().notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // Null for a decision nobody made: the first user, or an open instance.
  decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
});
