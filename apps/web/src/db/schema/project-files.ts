import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { attachmentBlobs } from "./attachments.ts";
import { user } from "./auth.ts";
import { projects } from "./projects.ts";

/**
 * A working file shared in a project: a deck, a spreadsheet, a PDF. Binary
 * files cannot be merged, so every write is a whole new version; the file's
 * current one is its highest `number`. See docs/internals/projects.md.
 */
export const projectFiles = pgTable(
  "project_files",
  {
    id: text().primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_files_project_name_idx").on(t.projectId, t.name)],
);

export const projectFileVersions = pgTable(
  "project_file_versions",
  {
    id: text().primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => projectFiles.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    /**
     * Bytes registered under the project owner, so they live exactly as long
     * as the project. Every version holding the same bytes shares one blob.
     */
    blobId: text("blob_id")
      .notNull()
      .references(() => attachmentBlobs.id),
    size: integer().notNull(),
    mediaType: text("media_type").notNull(),
    origin: text({ enum: ["user", "model"] }).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** The answer that wrote a model version; consecutive saves from one answer collapse. */
    generationId: text("generation_id"),
    /** Kept past the retention window, with an optional name ("Sent to client"). */
    pinned: boolean().notNull().default(false),
    label: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_file_versions_file_number_idx").on(t.fileId, t.number),
    index("project_file_versions_blob_id_idx").on(t.blobId),
  ],
);

/** Instance-wide limits an admin sets for project files; one row, id 1. */
export const projectFileSettings = pgTable("project_file_settings", {
  id: integer().primaryKey(),
  /** Every version of every file in one project, together. */
  maxProjectBytes: bigint("max_project_bytes", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
