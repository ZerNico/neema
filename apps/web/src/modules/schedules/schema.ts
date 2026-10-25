import { Schema } from "effect";
import { ScheduleGrant } from "~/modules/integrations/grant.ts";
import { EntityId } from "~/entity-id.ts";

/** The longest each text setting may be, in a saved schedule and a draft alike. */
export const SCHEDULE_TEXT_LIMITS = {
  name: 200,
  scheduleText: 500,
  cron: 100,
  timezone: 100,
  prompt: 8000,
} as const;
const required = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

/** 5-field cron expression; the module's cron.ts validates it parses. */
export const CronExpression = required(SCHEDULE_TEXT_LIMITS.cron);
/** IANA timezone name; validated with Intl at write time. */
export const Timezone = required(SCHEDULE_TEXT_LIMITS.timezone);

export const ScheduleNotify = Schema.Literals(["off", "always", "conditional"]);
export type ScheduleNotify = typeof ScheduleNotify.Type;

export const ScheduleSettings = Schema.Struct({
  name: required(SCHEDULE_TEXT_LIMITS.name),
  /** The natural-language cadence the user wrote or the model proposed. */
  scheduleText: required(SCHEDULE_TEXT_LIMITS.scheduleText),
  cron: CronExpression,
  timezone: Timezone,
  endAt: Schema.NullOr(Schema.String),
  prompt: required(SCHEDULE_TEXT_LIMITS.prompt),
  /** Retained selections, never permissions: both degrade explicitly at fire time. */
  modelId: Schema.NullOr(EntityId),
  agentId: Schema.NullOr(EntityId),
  /** Null leaves the choice to each chat. */
  imageModelId: Schema.NullOr(EntityId),
  searchEnabled: Schema.Boolean,
  researchEnabled: Schema.Boolean,
  collectionIds: Schema.Array(EntityId).check(Schema.isMaxLength(5)),
  skillIds: Schema.Array(EntityId).check(Schema.isMaxLength(20)),
  /**
   * `new`: a fresh chat each fire. `same`: one chat every fire, `chatId`, or one
   * the next fire creates when that is null.
   */
  chatMode: Schema.Literals(["new", "same"]),
  chatId: Schema.NullOr(EntityId),
  /**
   * The most each integration may do during a fire, granted here because
   * nobody is present to approve then. Only the person sets it, never the model.
   */
  integrationGrants: Schema.Array(ScheduleGrant).check(Schema.isMaxLength(10)),
  /** When a run tells its owner: after every run, only when the answer decides it is worth it, or never. */
  notify: ScheduleNotify,
});
export type ScheduleSettings = typeof ScheduleSettings.Type;

/** A stored schedule as the settings its editors start from. */
export const scheduleToSettings = (
  schedule: {
    readonly [K in Exclude<keyof ScheduleSettings, "endAt">]: ScheduleSettings[K];
  } & { readonly endAt: Date | null },
): ScheduleSettings => ({
  name: schedule.name,
  scheduleText: schedule.scheduleText,
  cron: schedule.cron,
  timezone: schedule.timezone,
  endAt: schedule.endAt ? schedule.endAt.toISOString() : null,
  prompt: schedule.prompt,
  modelId: schedule.modelId,
  agentId: schedule.agentId,
  imageModelId: schedule.imageModelId,
  searchEnabled: schedule.searchEnabled,
  researchEnabled: schedule.researchEnabled,
  collectionIds: [...schedule.collectionIds],
  skillIds: [...schedule.skillIds],
  chatMode: schedule.chatMode,
  chatId: schedule.chatId,
  integrationGrants: schedule.integrationGrants.map((grant) => ({ ...grant })),
  notify: schedule.notify,
});

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
/** The schedule moved past the revision a save was based on. */
export class ScheduleChanged extends Schema.TaggedError<ScheduleChanged>()("ScheduleChanged", {
  scheduleId: Schema.String,
}) {
  get reason() {
    return "schedule changed; reload before saving";
  }
}
export class ScheduleRejected extends Schema.TaggedError<ScheduleRejected>()("ScheduleRejected", {
  reason: Schema.String,
}) {}
