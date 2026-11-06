import { describe, expect, it } from "vitest";
import { CHECKPOINTS_KEPT, groupVersions, thinnedCheckpoints } from "./versions.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 9, minutes));
const person = (revision: number, minutes: number, userName = "Ada", userId = userName) => ({
  revision,
  origin: "user" as const,
  userId,
  userName,
  createdAt: at(minutes),
});

describe("a document's versions", () => {
  it("runs one author's steps together until another author or a pause, newest first", () => {
    const versions = groupVersions(
      [
        person(11, 0),
        person(12, 2),
        // The server's own repair joins the run it follows.
        { revision: 13, origin: "user", userId: null, userName: null, createdAt: at(2) },
        { revision: 14, origin: "model", userId: null, userName: null, createdAt: at(3) },
        { revision: 15, origin: "model", userId: null, userName: null, createdAt: at(4) },
        person(16, 5, "Grace"),
        // Twenty minutes later is a new version, by the same person.
        person(17, 25, "Grace"),
      ],
      { revision: 10, at: at(0) },
    );
    expect(versions.map(({ revision, author }) => [revision, author])).toEqual([
      [17, { kind: "person", name: "Grace" }],
      [16, { kind: "person", name: "Grace" }],
      [15, { kind: "assistant" }],
      [13, { kind: "person", name: "Ada" }],
      [10, null],
    ]);
  });

  it("tells apart two people with the same name", () => {
    const versions = groupVersions(
      [person(1, 0, "Alex", "user-1"), person(2, 1, "Alex", "user-2")],
      { revision: 0, at: at(0) },
    );
    expect(versions.map((version) => version.revision)).toEqual([2, 1, 0]);
  });
});

describe("thinning kept versions", () => {
  const now = Date.UTC(2026, 9, 31, 12);
  const daysAgo = (days: number, hour = 9) =>
    new Date(now - days * 86_400_000 + (hour - 12) * 3_600_000);

  it("keeps the last of each day for 90 days and the last of each week before", () => {
    const dropped = thinnedCheckpoints(
      [
        // Two on one recent day: the later stays.
        { revision: 10, at: daysAgo(3, 9), named: false },
        { revision: 11, at: daysAgo(3, 15), named: false },
        { revision: 12, at: daysAgo(2), named: false },
        // Three on 2026-05-27, 28 and 29 (Wednesday to Friday), one week: the Friday stays.
        { revision: 2, at: daysAgo(157), named: false },
        { revision: 3, at: daysAgo(156), named: false },
        { revision: 4, at: daysAgo(155), named: false },
      ],
      now,
    );
    expect(dropped.toSorted((a, b) => a - b)).toEqual([2, 3, 10]);
  });

  it("never drops a named version, and keeps at most 200 unnamed ones, newest first", () => {
    const many = Array.from({ length: CHECKPOINTS_KEPT + 5 }, (_, index) => ({
      revision: index + 1,
      at: daysAgo(400 + (CHECKPOINTS_KEPT + 5 - index) * 7),
      named: false,
    }));
    const dropped = thinnedCheckpoints(
      [...many, { revision: 0, at: daysAgo(3000), named: true }],
      now,
    );
    expect(dropped.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
