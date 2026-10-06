import { describe, expect, it } from "vitest";
import { splitIntegrationMentions } from "./mentions.ts";

const integrations = [
  { id: "outline", name: "Outline" },
  { id: "jira-ops", name: "Jira Ops" },
  { id: "jira", name: "Jira" },
];

describe("splitIntegrationMentions", () => {
  it("finds a mention at the start, mid-sentence and before punctuation", () => {
    expect(
      splitIntegrationMentions("@Outline find the roadmap, then ask @outline.", integrations),
    ).toEqual([
      { kind: "mention", start: 0, text: "@Outline", integrationId: "outline" },
      { kind: "text", start: 8, text: " find the roadmap, then ask " },
      { kind: "mention", start: 36, text: "@outline", integrationId: "outline" },
      { kind: "text", start: 44, text: "." },
    ]);
  });

  it("leaves emails, longer words and unknown names as text", () => {
    for (const text of ["mail me@Outline.com", "see @Outlines", "ask @Notion", "no mention"])
      expect(splitIntegrationMentions(text, integrations)).toEqual([
        { kind: "text", start: 0, text },
      ]);
  });

  it("joins back to the input", () => {
    const text = "line one\n@Outline\n\n  @Outline twice";
    expect(
      splitIntegrationMentions(text, integrations)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });

  it("names each integration by its own name, the longest first", () => {
    expect(splitIntegrationMentions("@Jira Ops and @Jira", integrations)).toEqual([
      { kind: "mention", start: 0, text: "@Jira Ops", integrationId: "jira-ops" },
      { kind: "text", start: 9, text: " and " },
      { kind: "mention", start: 14, text: "@Jira", integrationId: "jira" },
    ]);
    expect(splitIntegrationMentions("@Outline", [])).toEqual([
      { kind: "text", start: 0, text: "@Outline" },
    ]);
  });
});
