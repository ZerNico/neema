import { describe, expect, it } from "vitest";
import { firstNameOf, greetingFor } from "./greeting.ts";

describe("firstNameOf", () => {
  it("takes the leading word of a full name", () => {
    expect(firstNameOf("Ada Lovelace")).toBe("Ada");
  });

  it("accepts a single-word handle", () => {
    expect(firstNameOf("ada")).toBe("ada");
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(firstNameOf("  Ada   Lovelace ")).toBe("Ada");
  });

  it("rejects an address", () => {
    expect(firstNameOf("ada@example.com")).toBeNull();
  });

  it("rejects an overlong identifier", () => {
    expect(firstNameOf("a".repeat(25))).toBeNull();
  });

  it("rejects empty and missing names", () => {
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });
});

// Every line a roll can land on, sampled finely enough to hit each one.
const every = (name: string | null, now: Date) =>
  Array.from({ length: 20 }, (_, i) => greetingFor(name, now, i / 20));

describe("greetingFor", () => {
  // Local-time constructors, so the hour is the one the reader sees.
  const tuesdayMorning = new Date(2026, 8, 29, 9);
  const tuesdayNight = new Date(2026, 8, 29, 23);
  const mondayMorning = new Date(2026, 8, 28, 8);
  const fridayAfternoon = new Date(2026, 9, 2, 15);
  const saturdayMorning = new Date(2026, 9, 3, 10);
  const newYear = new Date(2027, 0, 1, 14);

  it("keeps the classic line first, by first name", () => {
    expect(greetingFor("Ada Lovelace", tuesdayMorning, 0)).toBe("What can I help with, Ada?");
  });

  it("drops the name when it isn't one", () => {
    expect(greetingFor("ada@example.com", tuesdayMorning, 0)).toBe("What can I help with?");
    expect(every("ada@example.com", tuesdayNight)).not.toContainEqual(expect.stringContaining(","));
  });

  it("follows the hour", () => {
    expect(every("Ada", tuesdayMorning)).toContain("Good morning, Ada");
    expect(every("Ada", tuesdayMorning)).not.toContain("Good evening, Ada");
    expect(every("Ada", tuesdayNight)).toContain("Up late, Ada?");
  });

  it("adds the day's occasion", () => {
    expect(every("Ada", mondayMorning)).toContain("New week, Ada. Where do we start?");
    expect(every("Ada", fridayAfternoon)).toContain("Happy Friday, Ada");
    expect(every("Ada", saturdayMorning)).toContain("Weekend project, Ada?");
    expect(every("Ada", newYear)).toContain("Happy New Year, Ada");
    expect(new Set(every("Ada", tuesdayMorning)).size).toBe(3);
  });

  it("stays in range at the top of the roll", () => {
    expect(greetingFor("Ada", tuesdayMorning, 0.999_999)).toBe("What’s first today, Ada?");
  });
});
