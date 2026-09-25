import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { groups } from "./groups.ts";

/**
 * A place for continuing work: instructions every chat in it receives, shared
 * documents and project memory, and the people who may use it. Chats inside
 * stay private to whoever started them. See docs/internals/projects.md.
 */
export const projects = pgTable(
  "projects",
  {
    id: text().primaryKey(),
    /** The owner: manages members and may delete the project. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    instructions: text().notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("projects_user_id_idx").on(t.userId)],
);

/** What a member may do beyond using the project; the owner is never a row here. */
export const PROJECT_MEMBER_ROLES = ["viewer", "editor"] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text({ enum: PROJECT_MEMBER_ROLES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_id_idx").on(t.userId),
  ],
);

export const projectGroupGrants = pgTable(
  "project_group_grants",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    role: text({ enum: PROJECT_MEMBER_ROLES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.groupId] }),
    index("project_group_grants_group_id_idx").on(t.groupId),
  ],
);
