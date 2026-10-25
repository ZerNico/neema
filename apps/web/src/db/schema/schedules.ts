import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";
import { integrationConfigs, integrationConnections } from "./integrations.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

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
    // Retained like `modelId`. In a chat the schedule keeps using, a fire's
    // choice moves that chat's image model, so editing the schedule applies.
    imageModelId: text("image_model_id"),
    searchEnabled: boolean("search_enabled").notNull().default(false),
    researchEnabled: boolean("research_enabled").notNull().default(false),
    collectionIds: jsonb("collection_ids").$type<string[]>().notNull().default([]),
    skillIds: jsonb("skill_ids").$type<string[]>().notNull().default([]),
    /**
     * `new` fires into a fresh chat each time; `same` keeps using `chatId`, and
     * a null `chatId` means the next fire creates that chat and stores it.
     */
    chatMode: text("chat_mode", { enum: ["new", "same"] })
      .notNull()
      .default("new"),
    chatId: text("chat_id").references(() => conversations.id, { onDelete: "set null" }),
    paused: boolean().notNull().default(false),
    /**
     * When a fire tells its owner: `always` once each run ends, `conditional`
     * only if the answer calls `notify_user`, `off` never. A failed run tells
     * them in both modes that notify.
     */
    notify: text({ enum: ["off", "always", "conditional"] })
      .notNull()
      .default("always"),
    /** Null while paused or past endAt; the claim reschedules from now, never replays. */
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedules_user_idx").on(t.userId),
    index("schedules_due_idx")
      .on(t.nextFireAt)
      .where(sql`${t.nextFireAt} is not null`),
    // Deleting a chat clears `chat_id` on the schedules that use it.
    index("schedules_chat_idx").on(t.chatId),
  ],
);

/**
 * Consent a schedule gives up front, since nobody is present to approve
 * during a fire: the most one of the owner's accounts may do. Anything beyond
 * it is refused to the model, never waited on. Keyed by account, so one
 * account never holds two grants with different access.
 */
export const scheduleIntegrationGrants = pgTable(
  "schedule_integration_grants",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    // Null once disconnected: a fire then ends with a reason, and the owner's
    // next account there takes it only while it is their only one.
    connectionId: text("connection_id").references(() => integrationConnections.id, {
      onDelete: "set null",
    }),
    // Null once the integration was deleted: the grant stays so a fire ends with
    // a reason and the editor shows it, until the owner turns it off.
    integrationId: text("integration_id").references(() => integrationConfigs.id, {
      onDelete: "set null",
    }),
    access: text({ enum: ["read", "write"] }).notNull(),
    allowances: jsonb().$type<NonNullable<IntegrationGrant["allowances"]>>(),
  },
  (t) => [
    uniqueIndex("schedule_integration_grants_account_idx").on(t.scheduleId, t.connectionId),
    index("schedule_integration_grants_connection_idx").on(t.connectionId),
    index("schedule_integration_grants_integration_idx").on(t.integrationId),
  ],
);

/**
 * One row per fire. `conversationId` is null when the turn never started (no
 * available model), so error runs still show in the history without a chat.
 * A pending row is written before the fire can start and atomically bound to
 * the turn. Generation outcome is read off the conversation's assistant message;
 * this status only records whether the turn started at all.
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
    leaseUntil: timestamp("lease_until", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp() + interval '60 seconds'`),
    status: text({ enum: ["pending", "started", "error", "skipped"] }).notNull(),
    error: text(),
    /** The fire's answer and the attempt that is the fire's, bound with `started`. */
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    generationId: text("generation_id"),
    /**
     * Set once by the claim that sees the run over, which then tells the owner;
     * null while it may still end. Every way a run ends meets that claim.
     */
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /** What the answer asked to tell its owner through `notify_user`, if it did. */
    notifyMessage: text("notify_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("schedule_runs_schedule_idx").on(t.scheduleId, t.firedAt),
    index("schedule_runs_pending_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'pending'`),
    index("schedule_runs_unsettled_idx")
      .on(t.firedAt)
      .where(sql`${t.settledAt} is null`),
    index("schedule_runs_message_idx").on(t.messageId),
    index("schedule_runs_conversation_idx").on(t.conversationId),
  ],
);
