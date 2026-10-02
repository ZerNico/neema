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
 * Font faces for rendering presentations: ones an admin uploaded, and curated
 * Google families fetched on first use. The bytes live in the row rather than
 * the blob store: blobs belong to a user, and a shared font must outlive the
 * admin who added it. Uploading the same family and style again replaces the
 * face; an upload always wins over a fetched one.
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
    /** Uploads are kept; fetched faces are a cache, evicted when unused. */
    source: text({ enum: ["upload", "google"] })
      .notNull()
      .default("upload"),
    /** When a deck last needed a fetched face; the sweep judges it by the database clock. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("presentation_fonts_face_idx").on(t.family, t.bold, t.italic)],
);
