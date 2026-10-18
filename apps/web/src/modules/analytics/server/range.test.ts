import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UsageRangeInput } from "../schema.ts";
import { previousUsageWindow, resolveUsageWindow, windowDays } from "./range.ts";

const iso = (date: Date) => date.toISOString();
const decode = Schema.decodeUnknownSync(UsageRangeInput);

// Mid-afternoon on purpose: a preset must snap to the day boundary rather than
// carry the time of day into the window.
const NOW = new Date("2026-08-24T15:42:07.311Z");

describe("resolveUsageWindow", () => {
  it("ends a preset at tomorrow's UTC midnight so today is a whole bucket", () => {
    const window = resolveUsageWindow({ kind: "preset", days: 7 }, NOW);
    expect(iso(window.to)).toBe("2026-08-25T00:00:00.000Z");
    expect(iso(window.from)).toBe("2026-08-18T00:00:00.000Z");
  });

  it("spans exactly `days` UTC days", () => {
    for (const days of [7, 30, 90] as const) {
      const window = resolveUsageWindow({ kind: "preset", days }, NOW);
      const span = window.to.getTime() - window.from.getTime();
      expect(span / (24 * 60 * 60 * 1000)).toBe(days);
      expect(windowDays(window)).toHaveLength(days);
    }
  });

  it("passes a custom window through untouched", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    const to = new Date("2026-04-01T00:00:00.000Z");
    expect(resolveUsageWindow({ kind: "custom", from, to }, NOW)).toEqual({ from, to });
  });
});

describe("previousUsageWindow", () => {
  it("is adjacent and equal in length, with no shared instant and no gap", () => {
    const current = resolveUsageWindow({ kind: "preset", days: 30 }, NOW);
    const previous = previousUsageWindow(current);

    expect(iso(previous.to)).toBe(iso(current.from));
    expect(previous.to.getTime() - previous.from.getTime()).toBe(
      current.to.getTime() - current.from.getTime(),
    );
  });

  it("handles a custom window of arbitrary length", () => {
    const current = {
      from: new Date("2026-03-10T00:00:00.000Z"),
      to: new Date("2026-03-13T00:00:00.000Z"),
    };
    expect(previousUsageWindow(current)).toEqual({
      from: new Date("2026-03-07T00:00:00.000Z"),
      to: new Date("2026-03-10T00:00:00.000Z"),
    });
  });
});

describe("windowDays", () => {
  it("excludes the exclusive end bound", () => {
    const days = windowDays({
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(days).toEqual(["2026-08-10", "2026-08-11", "2026-08-12"]);
  });

  it("yields a single key for a one-day window", () => {
    expect(
      windowDays({
        from: new Date("2026-08-10T00:00:00.000Z"),
        to: new Date("2026-08-11T00:00:00.000Z"),
      }),
    ).toEqual(["2026-08-10"]);
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(
      windowDays({
        from: new Date("2026-12-30T00:00:00.000Z"),
        to: new Date("2027-01-02T00:00:00.000Z"),
      }),
    ).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);

    // 2028 is a leap year: Feb 29 must appear.
    expect(
      windowDays({
        from: new Date("2028-02-28T00:00:00.000Z"),
        to: new Date("2028-03-01T00:00:00.000Z"),
      }),
    ).toEqual(["2028-02-28", "2028-02-29"]);
  });
});

describe("UsageRangeInput", () => {
  it("decodes custom boundaries from ISO strings", () => {
    const range = decode({
      kind: "custom",
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
    expect(range.kind).toBe("custom");
    if (range.kind !== "custom") throw new Error("unreachable");
    expect(range.from).toBeInstanceOf(Date);
    expect(iso(range.to)).toBe("2026-08-16T00:00:00.000Z");
  });

  it("rejects a reversed or empty window", () => {
    const reversed = {
      kind: "custom",
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
    };
    expect(() => decode(reversed)).toThrow(/\nfrom must be before to$/);
    // from === to would scan nothing; the filter is `<`, not `<=`.
    const empty = {
      kind: "custom",
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-10T00:00:00.000Z",
    };
    expect(() => decode(empty)).toThrow(/\nfrom must be before to$/);
  });

  it("rejects a preset outside the offered set", () => {
    expect(() => decode({ kind: "preset", days: 5 })).toThrow(
      /^Expected 7 \| 30 \| 90\n  at \["days"\]/,
    );
  });
});
