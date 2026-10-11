import { createHash } from "node:crypto";
import type { SheetMoment } from "../schema.ts";

/** Days from Excel's day 0 (1899-12-30) to 1970-01-01. */
const UNIX_EPOCH_SERIAL = 25_569;

export const validTimeZone = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};

/** The serial a clock in `timeZone` shows at an instant: what NOW() returns there. */
export function serialAt(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone(timeZone) ? timeZone : "UTC",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((each) => each.type === type)?.value ?? 0);
  const wall =
    Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ) +
    (instant % 1000);
  return wall / 86_400_000 + UNIX_EPOCH_SERIAL;
}

/**
 * What every replica calculates volatile functions from at one revision: the
 * commit time on the sheet's clock, and a seed that changes with each edit.
 */
export const momentAt = (
  documentId: string,
  revision: number,
  committedAt: number,
  timeZone: string,
): SheetMoment => ({
  now: serialAt(committedAt, timeZone),
  seed: createHash("sha256").update(`${documentId}:${revision}`).digest().readUInt32BE(0),
});
