import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { conversations } from "./chat.ts";

/**
 * A recurring or one-shot prompt the server fires into a conversation: a new
 * one each time, or one chat it keeps using (`chatMode`).
 * The natural-language `scheduleText` is the human truth; `cron` + `timezone`
 * is the executable encoding of it. One-shot = cron for the single instant
 * plus `endAt` at that instant, so there is only one cadence representation.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prompt: text().notNull(),
    scheduleText: text("schedule_text").notNull(),
    cron: text().notNull(),
    timezone: text().notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    // Both ids are retained selections, never foreign keys: a deleted model
    // falls back to the user's default at fire time, and a deleted agent
    // degrades the fire to a plain chat rather than erroring the schedule.
    modelId: text("model_id"),
    agentId: text("agent_id"),
    searchEnabled: boolean("search_enabled").notNull().default(false),
    researchEnabled: boolean("research_enabled").notNull().default(false),
    collectionIds: jsonb("collection_ids").$type<string[]>().notNull().default([]),
    skillIds: jsonb("skill_ids").$type<string[]>().notNull().default([]),
    /**
     * `new` fires into a fresh chat each time; `same` keeps using `chatId`, and
     * a null `chatId` means the next fire creates that chat and stores it.
     */
    chatMode: text("chat_mode", { enum: ["new", "same"] }).notNull().default("new"),
    chatId: text("chat_id").references(() => conversations.id, { onDelete: "set null" }),
    paused: boolean().notNull().default(false),
    /** Null while paused or past endAt; the claim reschedules from now, never replays. */
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedules_user_idx").on(t.userId),
    index("schedules_due_idx").on(t.nextFireAt).where(sql`${t.nextFireAt} is not null`),
    // Deleting a chat clears `chat_id` on the schedules that use it.
    index("schedules_chat_idx").on(t.chatId),
  ],
);

/**
 * One row per fire. `conversationId` is null when the turn never started (no
 * available model), so error runs still show in the history without a chat.
 * Generation outcome is read off the conversation's assistant message; this
 * status only records whether the turn started at all.
 */
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: text().primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    status: text({ enum: ["started", "error"] }).notNull(),
    error: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_runs_schedule_idx").on(t.scheduleId, t.firedAt)],
);
