import { describe, expect, it } from "vitest";
import { isValidTimezone, nextFireAt, previewFires, validateCron } from "./cron.ts";

describe("cron", () => {
  it("interprets the expression in the schedule's timezone", () => {
    // 7am in Berlin is 06:00 UTC in summer, 05:00 UTC in winter.
    const summer = nextFireAt("0 7 * * *", "Europe/Berlin", new Date("2026-06-01T00:00:00Z"));
    expect(summer?.toISOString()).toBe("2026-06-01T05:00:00.000Z");
    const winter = nextFireAt("0 7 * * *", "Europe/Berlin", new Date("2026-12-01T00:00:00Z"));
    expect(winter?.toISOString()).toBe("2026-12-01T06:00:00.000Z");
  });

  it("keeps the wall-clock time across a DST spring forward", () => {
    // Berlin springs forward on 2026-03-29; 7am local stays 7am local.
    const fires = previewFires("0 7 * * *", "Europe/Berlin", 4, new Date("2026-03-27T00:00:00Z"));
    expect(fires.map((fire) => fire.toISOString())).toEqual([
      "2026-03-27T06:00:00.000Z",
      "2026-03-28T06:00:00.000Z",
      "2026-03-29T05:00:00.000Z",
      "2026-03-30T05:00:00.000Z",
    ]);
  });

  it("fires once for a skipped local time instead of doubling", () => {
    // 02:30 does not exist in Berlin on the spring-forward day; the library
    // resolves it, and the day after must still fire exactly once.
    const fires = previewFires("30 2 * * *", "Europe/Berlin", 3, new Date("2026-03-28T00:00:00Z"));
    expect(fires).toHaveLength(3);
    expect(new Set(fires.map((fire) => fire.toISOString().slice(0, 10))).size).toBe(3);
  });

  it("stops a one-shot after its endAt instant", () => {
    const endAt = new Date("2026-06-01T05:00:00.000Z");
    const fires = previewFires(
      "0 7 1 6 *",
      "Europe/Berlin",
      5,
      new Date("2026-05-01T00:00:00Z"),
      endAt,
    );
    expect(fires.map((fire) => fire.toISOString())).toEqual(["2026-06-01T05:00:00.000Z"]);
    expect(previewFires("0 7 1 6 *", "Europe/Berlin", 5, endAt, endAt)).toEqual([]);
  });

  it("rejects unparseable and never-firing expressions with a short reason", () => {
    expect(validateCron("not a cron", "UTC")).toBeTruthy();
    expect(validateCron("0 7 * *", "UTC")).toBeTruthy();
    expect(validateCron("0 0 30 2 *", "UTC")).toBe("this expression never fires");
    expect(validateCron("0 */2 * * *", "UTC")).toBeNull();
    expect(validateCron("0 7 * * 1-5", "Europe/Berlin")).toBeNull();
    expect(validateCron("0 7 * * *", "Not/AZone")).toBeTruthy();
  });

  it("holds every cadence to at most one fire an hour", () => {
    // A leading seconds field would fire on every tick.
    expect(validateCron("* * * * * *", "UTC")).toMatch(/5-field/);
    expect(validateCron("*/10 * * * * *", "UTC")).toMatch(/5-field/);
    expect(validateCron("* * * * *", "UTC")).toMatch(/once an hour/);
    expect(validateCron("*/20 * * * *", "UTC")).toMatch(/once an hour/);
    // Two minutes apart once a day is still two fires within the hour.
    expect(validateCron("0,1 9 * * *", "UTC")).toMatch(/once an hour/);
    expect(validateCron("0 * * * *", "UTC")).toBeNull();
    expect(validateCron("0 9 L * *", "Europe/Berlin")).toBeNull();
  });

  it("accepts a valid expression whose first fire is far ahead", () => {
    expect(validateCron("0 0 29 2 *", "UTC")).toBeNull();
  });

  it("returns null nextFireAt when nothing fires after the given instant", () => {
    expect(nextFireAt("0 0 30 2 *", "UTC", new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("checks IANA timezone names", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
