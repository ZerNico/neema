import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { LIMIT_METRICS, LIMIT_PERIODS } from "~/modules/limits/rules.ts";
import { groups } from "./groups.ts";
import { models } from "./providers.ts";

/**
 * One usage limit: everyone's (no group) or a group's. A group's rule
 * replaces everyone's for the same measure, period and models; a null amount
 * there lifts it. See `docs/internals/limits.md`.
 */
export const usageLimits = pgTable(
  "usage_limits",
  {
    id: text().primaryKey(),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    metric: text({ enum: LIMIT_METRICS }).notNull(),
    period: text({ enum: LIMIT_PERIODS }).notNull(),
    /** USD for cost, a count for answers; null is "No limit", for a group's override only. */
    amount: doublePrecision(),
    /** Every model, or only those in `usage_limit_models`; a rule whose models are all gone limits nothing. */
    allModels: boolean("all_models").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("usage_limits_group_idx").on(t.groupId)],
);

export const usageLimitModels = pgTable(
  "usage_limit_models",
  {
    limitId: text("limit_id")
      .notNull()
      .references(() => usageLimits.id, { onDelete: "cascade" }),
    modelId: text("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.limitId, t.modelId] })],
);

/** Instance-wide settings for limits; one row, id 1. */
export const limitSettings = pgTable("limit_settings", {
  id: integer().primaryKey(),
  /** Where a day, a week (from Monday) and a month begin, for everyone alike. */
  timeZone: text("time_zone").notNull().default("UTC"),
  /** What everyone may store, in bytes; null is no quota. */
  storageBytes: bigint("storage_bytes", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A group's storage quota, replacing everyone's for its members; null lifts it.
 * Among several groups with one, the most generous wins.
 */
export const groupStorageQuotas = pgTable("group_storage_quotas", {
  groupId: text("group_id")
    .primaryKey()
    .references(() => groups.id, { onDelete: "cascade" }),
  bytes: bigint({ mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
