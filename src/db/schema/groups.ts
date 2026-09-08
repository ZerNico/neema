import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { models } from "./providers.ts";

// Admin-managed user groups. Membership is a separate app-owned table rather
// than a column on `user` — Better Auth owns that table's shape.

export const groups = pgTable("groups", {
  id: text().primaryKey(),
  name: text().notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Controls new grants of owned resources; existing grants are unaffected.
    canShare: boolean("can_share").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    // Access checks resolve "which groups is this user in" — the PK only
    // serves the group-side lookup.
    index("group_members_user_id_idx").on(t.userId),
  ],
);

// Which groups may use a `access = 'groups'` model. A private model with no
// rows here is deliberately visible to admins only (staging state).
export const modelGroupAccess = pgTable(
  "model_group_access",
  {
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.modelId, t.groupId] }),
    // Group deletion cascades through this side.
    index("model_group_access_group_id_idx").on(t.groupId),
  ],
);
