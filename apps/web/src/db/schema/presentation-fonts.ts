import {
  boolean,
  bytea,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

/**
 * Font faces an admin uploaded for rendering presentations. The bytes live in
 * the row rather than the blob store: blobs belong to a user, and a shared font
 * must outlive the admin who added it. Uploading the same family and style
 * again replaces the face.
 */
export const presentationFonts = pgTable(
  "presentation_fonts",
  {
    id: text().primaryKey(),
    /** The family a deck names (name ID 1). */
    family: text().notNull(),
    /** The family the rasterizer matches (typographic name, else the family). */
    renderFamily: text("render_family").notNull(),
    style: text().notNull(),
    bold: boolean().notNull(),
    italic: boolean().notNull(),
    embeddable: boolean().notNull(),
    format: text({ enum: ["ttf", "otf"] }).notNull(),
    fileName: text("file_name").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text().notNull(),
    bytes: bytea().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("presentation_fonts_face_idx").on(t.family, t.bold, t.italic)],
);
