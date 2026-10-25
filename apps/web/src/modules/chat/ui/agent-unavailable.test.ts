import { describe, expect, it } from "vitest";
import { agentUnavailableLines } from "./agent-unavailable.ts";

describe("agentUnavailableLines", () => {
  it("names what the reader may still see and counts the rest per kind", () => {
    expect(
      agentUnavailableLines([
        { kind: "integration", name: "Jira" },
        { kind: "collection", name: null },
        { kind: "skill", name: "Review" },
        { kind: "collection", name: null },
        { kind: "customTool", name: null },
      ]),
    ).toEqual([
      "2 of the agent’s collections are no longer available",
      "The agent’s skill “Review” is no longer available",
      "One of the agent’s tools is no longer available",
      "The agent’s integration “Jira” is no longer available",
    ]);
  });

  it("says nothing when the agent ran whole", () => {
    expect(agentUnavailableLines([])).toEqual([]);
  });
});
