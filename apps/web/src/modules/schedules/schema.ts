import { Schema } from "effect";
import { IntegrationGrant } from "~/modules/integrations/grant.ts";
import { EntityId } from "~/entity-id.ts";

/** 5-field cron expression; the module's cron.ts validates it parses. */
export const CronExpression = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
/** IANA timezone name; validated with Intl at write time. */
export const Timezone = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));

export const ScheduleNotify = Schema.Literals(["off", "always", "conditional"]);
export type ScheduleNotify = typeof ScheduleNotify.Type;

export const ScheduleSettings = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** The natural-language cadence the user wrote or the model proposed. */
  scheduleText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  cron: CronExpression,
  timezone: Timezone,
  endAt: Schema.NullOr(Schema.String),
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  /** Retained selections, never permissions: both degrade explicitly at fire time. */
  modelId: Schema.NullOr(EntityId),
  agentId: Schema.NullOr(EntityId),
  /** Absent keeps what is saved; null leaves the choice to each chat. */
  imageModelId: Schema.optionalKey(Schema.NullOr(EntityId)),
  searchEnabled: Schema.Boolean,
  researchEnabled: Schema.Boolean,
  collectionIds: Schema.Array(EntityId).check(Schema.isMaxLength(5)),
  skillIds: Schema.Array(EntityId).check(Schema.isMaxLength(20)),
  /**
   * `new`: a fresh chat each fire. `same`: one chat every fire, `chatId`, or one
   * the next fire creates when that is null. Optional so drafts written before
   * these existed still decode; absent means `new`.
   */
  chatMode: Schema.optionalKey(Schema.Literals(["new", "same"])),
  chatId: Schema.optionalKey(Schema.NullOr(EntityId)),
  /**
   * The most each integration may do during a fire, granted here because
   * nobody is present to approve then. Only the editor sets it; a draft
   * written in chat leaves it out, which keeps what is saved.
   */
  integrationGrants: Schema.optionalKey(
    Schema.Array(IntegrationGrant).check(Schema.isMaxLength(10)),
  ),
  /**
   * When a run tells its owner: after every run, only when the answer decides
   * it is worth it, or never. Absent keeps what is saved, or `always` for a new
   * schedule.
   */
  notify: Schema.optionalKey(ScheduleNotify),
});
export type ScheduleSettings = typeof ScheduleSettings.Type;

export const ScheduleSummary = Schema.Struct({
  id: EntityId,
  name: Schema.String,
  scheduleText: Schema.String,
  cron: Schema.String,
  timezone: Schema.String,
  paused: Schema.Boolean,
  nextFireAt: Schema.NullOr(Schema.String),
  lastFiredAt: Schema.NullOr(Schema.String),
});
export type ScheduleSummary = typeof ScheduleSummary.Type;

export interface ScheduleRunSummary {
  id: string;
  firedAt: string;
  status: "pending" | "started" | "error" | "skipped";
  error: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
}

export class ScheduleNotAvailable extends Schema.TaggedError<ScheduleNotAvailable>()(
  "ScheduleNotAvailable",
  { scheduleId: Schema.String },
) {}
export class ScheduleRejected extends Schema.TaggedError<ScheduleRejected>()("ScheduleRejected", {
  reason: Schema.String,
}) {}
