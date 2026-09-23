import { cadenceText, parseCadence } from "../cadence.ts";
import type { ScheduleSummary } from "../schema.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";

// The detail read returns the row, whose times are Dates rather than ISO strings.
type Labelled = Pick<ScheduleSummary, "paused" | "cron" | "scheduleText"> & {
  nextFireAt: string | Date | null;
};

/** A paused schedule already carries its badge; the line just drops the next run. */
export const nextFireLabel = (schedule: Labelled) => {
  if (schedule.paused) return null;
  if (!schedule.nextFireAt) return "No upcoming run";
  const next = new Date(schedule.nextFireAt);
  return next.getTime() <= Date.now() ? "Due now" : `Next run ${relativeAgeLabel(next)}`;
};

/** Named from the cron when the picker can read it, so a long day list stays one line. */
export const cadenceLabel = (schedule: Labelled) =>
  cadenceText(parseCadence(schedule.cron), true) ?? schedule.scheduleText;
