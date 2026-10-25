import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLocale, overwriteGetLocale } from "~/paraglide/runtime.js";
import { cadenceCron, cadenceText, isPreset, parseCadence, withKind } from "./cadence.ts";

const time = (hour: number, minute = 0) => ({ hour, minute });

describe("parseCadence", () => {
  it.each([
    ["15 * * * *", { kind: "hourly", every: 1, minute: 15 }, "15 * * * *"],
    ["0 */6 * * *", { kind: "hourly", every: 6, minute: 0 }, "0 */6 * * *"],
    ["0 7 * * *", { kind: "daily", time: time(7) }, "0 7 * * *"],
    ["30 7 * * 1-5", { kind: "weekdays", time: time(7, 30) }, "30 7 * * 1-5"],
    ["30 7 * * 5,4,3,2,1", { kind: "weekdays", time: time(7, 30) }, "30 7 * * 1-5"],
    ["0 9 * * 5,1", { kind: "weekly", days: [1, 5], time: time(9) }, "0 9 * * 1,5"],
    ["0 9 * * 7", { kind: "weekly", days: [0], time: time(9) }, "0 9 * * 0"],
    ["0 8 1 * *", { kind: "monthly", every: 1, days: [1], time: time(8) }, "0 8 1 * *"],
    [
      "0 8 15,1 */3 *",
      { kind: "monthly", every: 3, days: [1, 15], time: time(8) },
      "0 8 1,15 */3 *",
    ],
    ["0 8 24 12 *", { kind: "yearly", month: 12, days: [24], time: time(8) }, "0 8 24 12 *"],
    ["0 9 L * *", { kind: "monthly", every: 1, days: [32], time: time(9) }, "0 9 L * *"],
    ["0 9 L,1 */3 *", { kind: "monthly", every: 3, days: [1, 32], time: time(9) }, "0 9 1,L */3 *"],
    ["0 9 L 2 *", { kind: "yearly", month: 2, days: [32], time: time(9) }, "0 9 L 2 *"],
  ])("recognizes %s", (cron, cadence, canonical) => {
    expect(parseCadence(cron)).toEqual(cadence);
    expect(cadenceCron(parseCadence(cron))).toBe(canonical);
  });

  it.each([
    // Steps that do not divide the day or year drift at the wrap, so they stay raw.
    "0 */5 * * *",
    "0 8 1 */5 *",
    "*/15 * * * *",
    "0 7-9 * * *",
    "0 7 * 1 *",
    "0 7 1 * 1",
    "0 7 * * MON",
    "",
    "0 7 * *",
    "0 24 * * *",
    // 32 is how the picker spells "last day"; in a cron it is simply invalid.
    "0 9 32 * *",
    "0 9 LW * *",
  ])("keeps %j as a raw cron, verbatim", (cron) => {
    expect(parseCadence(cron)).toEqual({ kind: "cron", cron: cron.trim() });
  });
});

describe("cadenceText", () => {
  it.each([
    ["0 * * * *", "Every hour"],
    ["5 */2 * * *", "Every 2 hours at :05"],
    ["0 7 * * *", "Every day at 07:00"],
    ["0 7 * * 1-5", "Every weekday at 07:00"],
    ["0 9 * * 1,3,5", "Every Monday, Wednesday, and Friday at 09:00"],
    ["0 8 22 * *", "Every month on the 22nd at 08:00"],
    ["0 8 1,11 */3 *", "Every 3 months on the 1st and 11th at 08:00"],
    ["0 8 24 12 *", "Every December on the 24th at 08:00"],
    ["0 9 L * *", "Every month on the last day at 09:00"],
    ["0 9 15,L * *", "Every month on the 15th and last day at 09:00"],
  ])("describes %s", (cron, text) => {
    expect(cadenceText(parseCadence(cron))).toBe(text);
  });

  it("leaves a raw cron's description to the author", () => {
    expect(cadenceText(parseCadence("*/5 * * * *"))).toBeNull();
  });

  describe("in German", () => {
    const original = getLocale;
    beforeAll(() => overwriteGetLocale(() => "de"));
    afterAll(() => overwriteGetLocale(original));

    it.each([
      ["0 * * * *", "Jede Stunde"],
      ["5 */2 * * *", "Alle 2 Stunden um :05"],
      ["0 7 * * *", "Täglich um 07:00 Uhr"],
      ["0 9 * * 1,3,5", "Jeden Montag, Mittwoch und Freitag um 09:00 Uhr"],
      ["0 8 1,11 */3 *", "Alle 3 Monate am 1. und 11. um 08:00 Uhr"],
      ["0 8 24 12 *", "Jedes Jahr am 24. Dezember um 08:00 Uhr"],
      ["0 9 15,L * *", "Jeden Monat am 15. und letzten Tag um 09:00 Uhr"],
    ])("describes %s", (cron, text) => {
      expect(cadenceText(parseCadence(cron))).toBe(text);
    });
  });
});

describe("isPreset", () => {
  it("keeps the one-line row to what it can show", () => {
    expect(isPreset(parseCadence("0 9 * * 1"))).toBe(true);
    expect(isPreset(parseCadence("0 9 * * 1,5"))).toBe(false);
    expect(isPreset(parseCadence("0 */2 * * *"))).toBe(false);
    expect(isPreset(parseCadence("0 8 1,15 * *"))).toBe(false);
    expect(isPreset(parseCadence("0 8 24 12 *"))).toBe(false);
  });
});

describe("withKind", () => {
  it("keeps the chosen time and days across kinds", () => {
    const weekly = withKind(parseCadence("30 6 * * *"), "weekly");
    expect(cadenceCron(weekly)).toBe("30 6 * * 1");
    expect(cadenceCron(withKind(weekly, "hourly"))).toBe("30 * * * *");
    expect(cadenceCron(withKind(parseCadence("0 8 1,15 */3 *"), "yearly"))).toBe("0 8 1,15 1 *");
  });

  it("trims to a single day and no step for the presets", () => {
    expect(cadenceCron(withKind(parseCadence("0 8 1,15 */3 *"), "monthly", true))).toBe(
      "0 8 1 * *",
    );
    expect(cadenceCron(withKind(parseCadence("0 9 * * 1,5"), "weekly", true))).toBe("0 9 * * 1");
  });
});
