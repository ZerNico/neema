import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { conversations, messages } from "./chat.ts";
import { user } from "./auth.ts";
import type { ResearchProgress } from "~/modules/chat/research-schema.ts";
import type { UsageTotals } from "~/modules/analytics/server/usage.ts";

export const researchRuns = pgTable(
  "research_runs",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: text({ enum: ["queued", "running", "terminal"] })
      .notNull()
      .default("queued"),
    progress: jsonb().$type<ResearchProgress>().notNull(),
    owner: text(),
    leaseUntil: timestamp("lease_until", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '60 seconds'`),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    deadline: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`now() + interval '10 minutes'`),
    modelId: text("model_id").notNull(),
    modelName: text("model_name").notNull(),
    pricing: jsonb().$type<{ input: number; output: number | null }>(),
    snapshot: boolean().notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("research_runs_active_user_idx")
      .on(t.userId)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("research_runs_message_idx").on(t.messageId),
    index("research_runs_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);
export const researchTasks = pgTable(
  "research_tasks",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    title: text().notNull(),
    assignment: text().notNull(),
    status: text({ enum: ["queued", "running", "complete", "error", "aborted"] })
      .notNull()
      .default("queued"),
    report: text(),
    error: text(),
  },
  (t) => [uniqueIndex("research_tasks_run_ordinal_idx").on(t.runId, t.ordinal)],
);
export const researchCalls = pgTable(
  "research_calls",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => researchTasks.id, { onDelete: "set null" }),
    ordinal: integer().notNull(),
    phase: text().notNull(),
    reservedOutputTokens: integer("reserved_output_tokens").notNull(),
    status: text({ enum: ["running", "complete", "error"] })
      .notNull()
      .default("running"),
    usage: jsonb().$type<UsageTotals>(),
    usageComplete: boolean("usage_complete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("research_calls_run_ordinal_idx").on(t.runId, t.ordinal)],
);
