import { describe, expect, it } from "vitest";
import { groupVersions } from "./versions.ts";

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
