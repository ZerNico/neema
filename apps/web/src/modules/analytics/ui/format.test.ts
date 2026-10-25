import { afterEach, describe, expect, it } from "vitest";
import { baseLocale, overwriteGetLocale } from "~/paraglide/runtime.js";
import {
  formatCost,
  formatDay,
  formatPercent,
  formatPointDelta,
  formatRangeLabel,
  formatRelativeDelta,
} from "./format.ts";

const reading = (locale: "en" | "de") => overwriteGetLocale(() => locale);

afterEach(() => overwriteGetLocale(() => baseLocale));

describe("usage numbers", () => {
  it("read as they did in English", () => {
    reading("en");
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatDay("2026-08-12")).toBe("Aug 12");
    expect(formatPercent(0.42)).toBe("42%");
    expect(formatPointDelta(0.01)).toBe("+1.0pp");
    expect(formatRelativeDelta(150, 100)).toBe("+50%");
    expect(formatRangeLabel("2026-08-10T00:00:00Z", "2026-08-16T00:00:00Z")).toBe(
      "Aug 10 – Aug 15, 2026",
    );
  });

  it("read in German with German dates, decimals and units", () => {
    reading("de");
    expect(formatCost(1.234)).toBe("1,23 $");
    expect(formatDay("2026-08-12")).toBe("12. Aug.");
    expect(formatPercent(0.42)).toBe("42 %");
    expect(formatPointDelta(0.01)).toBe("+1,0 PP");
    expect(formatRelativeDelta(1, 0)).toBe("Neu");
    expect(formatRangeLabel("2026-08-10T00:00:00Z", "2026-08-16T00:00:00Z")).toBe(
      "10. Aug. – 15. Aug. 2026",
    );
  });
});
