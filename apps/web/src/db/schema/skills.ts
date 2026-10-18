import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { agents } from "./agents.ts";
import { attachmentBlobs } from "./attachments.ts";
import { groups } from "./groups.ts";
import { messages } from "./chat.ts";
import type { SkillFinding } from "~/modules/skills/package.ts";

export interface SkillSource {
  url: string;
  repository: string;
  path: string;
  commit: string;
  /** Locally computed package hash, never a remote assertion. */
  contentHash: string;
}

export const skills = pgTable(
  "skills",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    manualOnly: boolean("manual_only").notNull().default(false),
    audience: text({ enum: ["private", "instance"] })
      .notNull()
      .default("private"),
    revision: integer().notNull().default(1),
    /** Soft deletion preserves pinned historical revisions without making them invocable. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("skills_user_idx").on(t.userId)],
);

export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: text().primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    manualOnly: boolean("manual_only").notNull(),
    contentHash: text("content_hash").notNull(),
    findings: jsonb().$type<SkillFinding[]>().notNull().default([]),
    source: jsonb().$type<SkillSource>(),
    /** Baselines are revisions too, retained by this explicit reference. */
    baselineRevisionId: text("baseline_revision_id").references(
      (): AnyPgColumn => skillRevisions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_revisions_number_idx").on(t.skillId, t.revision),
    index("skill_revisions_baseline_idx").on(t.baselineRevisionId),
  ],
);

export const skillFiles = pgTable(
  "skill_files",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => skillRevisions.id, { onDelete: "cascade" }),
    path: text().notNull(),
    blobId: text("blob_id")
      .notNull()
      .references(() => attachmentBlobs.id, { onDelete: "restrict" }),
    byteSize: integer("byte_size").notNull(),
    sha256: text().notNull(),
    // Null for skill text. A binary asset records its own type: the shared
    // blob row keeps whichever type its first writer gave it.
    mediaType: text("media_type"),
  },
  (t) => [
    primaryKey({ columns: [t.revisionId, t.path] }),
    index("skill_files_blob_idx").on(t.blobId),
  ],
);

export const skillUserGrants = pgTable(
  "skill_user_grants",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.userId] }),
    index("skill_user_grants_user_idx").on(t.userId),
  ],
);

export const skillGroupGrants = pgTable(
  "skill_group_grants",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.groupId] }),
    index("skill_group_grants_group_idx").on(t.groupId),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** No FK: deleted dependencies must remain unavailable, not silently disappear. */
    skillId: text("skill_id").notNull(),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const messageSkills = pgTable(
  "message_skills",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => skillRevisions.id, { onDelete: "restrict" }),
    explicit: boolean().notNull(),
    position: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.skillId] }),
    index("message_skills_revision_idx").on(t.revisionId),
  ],
);
