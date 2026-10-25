import { m } from "~/paraglide/messages.js";
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

  it("counts the rest in German with the noun's own grammar", () => {
    expect(m.chat_agent_missing_skill_unnamed({ count: 1 }, { locale: "de" })).toBe(
      "Einer der Skills des Agenten ist nicht mehr verfügbar",
    );
    expect(m.chat_agent_missing_skill_unnamed({ count: 3 }, { locale: "de" })).toBe(
      "3 Skills des Agenten sind nicht mehr verfügbar",
    );
  });

  it("says nothing when the agent ran whole", () => {
    expect(agentUnavailableLines([])).toEqual([]);
  });
});
