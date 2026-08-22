import { describe, expect, it } from "vitest";
import { groupConversationsByDate } from "./conversation-groups.ts";

const now = new Date("2026-08-22T14:00:00");
const at = (iso: string) => ({ lastMessageAt: new Date(iso), createdAt: new Date(iso) });

describe("groupConversationsByDate", () => {
  it("buckets by calendar day, newest first", () => {
    const groups = groupConversationsByDate(
      [
        at("2026-08-22T09:00:00"),
        at("2026-08-21T23:30:00"),
        at("2026-08-18T10:00:00"),
        at("2026-08-01T10:00:00"),
        at("2026-01-01T10:00:00"),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 days",
      "Previous 30 days",
      "Older",
    ]);
    expect(groups.every((g) => g.conversations.length === 1)).toBe(true);
  });

  it("keeps same-bucket conversations together in input order", () => {
    const a = { ...at("2026-08-22T13:00:00"), id: "a" };
    const b = { ...at("2026-08-22T08:00:00"), id: "b" };
    const groups = groupConversationsByDate([a, b], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.conversations.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("falls back to createdAt when the chat has no messages", () => {
    const groups = groupConversationsByDate(
      [{ lastMessageAt: null, createdAt: new Date("2026-08-21T12:00:00") }],
      now,
    );
    expect(groups[0]!.label).toBe("Yesterday");
  });

  it("accepts serialized date strings", () => {
    const groups = groupConversationsByDate(
      [{ lastMessageAt: "2026-08-21T12:00:00", createdAt: "2026-08-21T12:00:00" }],
      now,
    );
    expect(groups[0]!.label).toBe("Yesterday");
  });

  it("treats an unparseable or future timestamp as today rather than dropping it", () => {
    const groups = groupConversationsByDate(
      [{ lastMessageAt: "not a date", createdAt: "not a date" }, at("2027-01-01T00:00:00")],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[0]!.conversations).toHaveLength(2);
  });

  it("returns nothing for an empty list", () => {
    expect(groupConversationsByDate([], now)).toEqual([]);
  });
});
