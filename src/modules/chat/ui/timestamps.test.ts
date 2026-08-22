import { describe, expect, it } from "vitest";
import {
  absoluteLabel,
  activityStamp,
  buildMessageStamps,
  clockLabel,
  dayLabel,
} from "./timestamps.ts";

// en-GB keeps the labels 24-hour and day-first, which pins the assertions
// below to something readable; the code itself always uses the visitor locale.
const LOCALE = "en-GB";
const NOW = new Date("2026-08-22T14:00:00");
const at = (iso: string) => new Date(iso);

describe("dayLabel", () => {
  it("names the current and previous day", () => {
    expect(dayLabel(at("2026-08-22T09:00:00"), NOW, LOCALE)).toBe("Today");
    expect(dayLabel(at("2026-08-21T23:30:00"), NOW, LOCALE)).toBe("Yesterday");
  });

  it("counts calendar days, not elapsed hours", () => {
    // Half an hour earlier, but on the other side of midnight.
    expect(dayLabel(at("2026-08-21T23:59:00"), at("2026-08-22T00:20:00"), LOCALE)).toBe(
      "Yesterday",
    );
  });

  it("uses the weekday for the rest of the past week", () => {
    expect(dayLabel(at("2026-08-20T12:00:00"), NOW, LOCALE)).toBe("Thursday");
    expect(dayLabel(at("2026-08-17T12:00:00"), NOW, LOCALE)).toBe("Monday");
  });

  it("switches to a date once the weekday would be ambiguous", () => {
    // Seven days back is the same weekday as today.
    expect(dayLabel(at("2026-08-15T12:00:00"), NOW, LOCALE)).toBe("15 August");
  });

  it("adds the year only once it is no longer the current one", () => {
    expect(dayLabel(at("2026-01-03T12:00:00"), NOW, LOCALE)).toBe("3 January");
    expect(dayLabel(at("2025-12-30T12:00:00"), NOW, LOCALE)).toBe("30 December 2025");
  });

  it("treats a future timestamp as today rather than as a past date", () => {
    expect(dayLabel(at("2026-08-25T12:00:00"), NOW, LOCALE)).toBe("Today");
  });
});

describe("clockLabel", () => {
  it("formats the local clock time", () => {
    expect(clockLabel(at("2026-08-22T14:32:00"), LOCALE)).toBe("14:32");
  });

  it("normalizes the narrow no-break space a 12-hour locale emits", () => {
    const label = clockLabel(at("2026-08-22T14:32:00"), "en-US");
    expect(label).toBe("2:32 PM");
    expect(label).not.toMatch(/[\u202F\u00A0]/);
  });
});

describe("absoluteLabel", () => {
  it("spells the whole date and time out", () => {
    const label = absoluteLabel(at("2026-08-22T14:32:00"), LOCALE);
    expect(label).toContain("Saturday");
    expect(label).toContain("August");
    expect(label).toContain("2026");
    expect(label).toContain("14:32");
  });
});

describe("buildMessageStamps", () => {
  const message = (id: string, createdAt: string, editedAt?: string) => ({
    id,
    createdAt,
    ...(editedAt === undefined ? {} : { editedAt }),
  });

  it("heads only the messages that open a new day", () => {
    const stamps = buildMessageStamps(
      [
        message("a", "2026-08-21T09:00:00"),
        message("b", "2026-08-21T18:00:00"),
        message("c", "2026-08-22T08:00:00"),
      ],
      NOW,
      LOCALE,
    );
    expect(stamps.get("a")?.dayLabel).toBe("Yesterday");
    expect(stamps.get("b")?.dayLabel).toBeNull();
    expect(stamps.get("c")?.dayLabel).toBe("Today");
  });

  it("heads the first message even when it is from today", () => {
    const stamps = buildMessageStamps([message("a", "2026-08-22T08:00:00")], NOW, LOCALE);
    expect(stamps.get("a")?.dayLabel).toBe("Today");
  });

  it("carries the clock time and a machine-readable value", () => {
    const stamps = buildMessageStamps([message("a", "2026-08-22T08:05:00Z")], NOW, LOCALE);
    expect(stamps.get("a")?.iso).toBe("2026-08-22T08:05:00.000Z");
    expect(stamps.get("a")?.clock).toBe(clockLabel(at("2026-08-22T08:05:00Z"), LOCALE));
  });

  it("mentions an edit in the full description", () => {
    const stamps = buildMessageStamps(
      [message("a", "2026-08-22T08:00:00", "2026-08-22T09:30:00")],
      NOW,
      LOCALE,
    );
    expect(stamps.get("a")?.absolute).toContain("· edited");
    expect(stamps.get("a")?.absolute).toContain("09:30");
  });

  it("skips an unreadable timestamp without breaking the run", () => {
    const stamps = buildMessageStamps(
      [message("a", "not a date"), message("b", "2026-08-22T08:00:00")],
      NOW,
      LOCALE,
    );
    expect(stamps.has("a")).toBe(false);
    expect(stamps.get("b")?.dayLabel).toBe("Today");
  });
});

describe("activityStamp", () => {
  const conversation = (lastMessageAt: string | null, createdAt: string) => ({
    lastMessageAt,
    createdAt,
  });

  it("shows the clock while the activity is still today", () => {
    expect(
      activityStamp(conversation("2026-08-22T09:05:00", "2026-08-01T09:00:00"), NOW, LOCALE),
    ).toBe("9:05");
  });

  it("shows the day label once it is not today", () => {
    expect(
      activityStamp(conversation("2026-08-21T09:05:00", "2026-08-01T09:00:00"), NOW, LOCALE),
    ).toBe("Yesterday");
    expect(
      activityStamp(conversation("2026-05-04T09:05:00", "2026-05-01T09:00:00"), NOW, LOCALE),
    ).toBe("4 May");
  });

  it("falls back to creation for a chat with no messages", () => {
    expect(activityStamp(conversation(null, "2026-08-21T09:05:00"), NOW, LOCALE)).toBe("Yesterday");
  });

  it("stays empty rather than printing an unreadable date", () => {
    expect(activityStamp(conversation("not a date", "also not a date"), NOW, LOCALE)).toBe("");
  });
});
