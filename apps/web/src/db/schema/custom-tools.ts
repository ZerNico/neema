import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  CustomToolDependency,
  CustomToolFunctionManifest,
} from "~/modules/custom-tools/schema.ts";
import { agents } from "./agents.ts";
import { user } from "./auth.ts";
import { groups } from "./groups.ts";

/**
 * One row is the whole module: identity, the source, its exact dependencies,
 * the bundle built from them and the functions that bundle exposes. A save
 * replaces the row; an answer that ran an older build remembers what it
 * needs (display name, result) on its own tool-call row, the way web and
 * desktop tools do, so nothing here is versioned.
 */
export const customTools = pgTable(
  "custom_tools",
  {
    id: text().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    source: text().notNull(),
    dependencies: jsonb().$type<CustomToolDependency[]>().notNull().default([]),
    compiled: text().notNull(),
    functions: jsonb().$type<CustomToolFunctionManifest[]>().notNull(),
    enabled: boolean().notNull().default(true),
    // Shared like agents and skills: "instance" is everyone signed in,
    // "private" only the users and groups granted below; admins always pass.
    // Checked at attach and on every attempt against the sender, so a shared
    // agent never carries a tool to someone it was not shared with.
    audience: text({ enum: ["private", "instance"] })
      .notNull()
      .default("instance"),
    // Changes on every save; the editor sends the one it loaded so two
    // admins cannot overwrite each other.
    version: text().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("custom_tools_slug_idx").on(t.slug)],
);

/**
 * Agent attachment is module-level; every function of the module is offered.
 * Deleting a module takes the cascade: an answer that already called it keeps
 * its own tool row, so nothing here has to outlive the module.
 */
export const agentCustomTools = pgTable(
  "agent_custom_tools",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => customTools.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] })],
);

export const customToolUserGrants = pgTable(
  "custom_tool_user_grants",
  {
    toolId: text("tool_id")
      .notNull()
      .references(() => customTools.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.toolId, t.userId] })],
);

export const customToolGroupGrants = pgTable(
  "custom_tool_group_grants",
  {
    toolId: text("tool_id")
      .notNull()
      .references(() => customTools.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.toolId, t.groupId] })],
);
