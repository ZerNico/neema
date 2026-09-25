import { describe, expect, it } from "vitest";
import { splitIntegrationMentions } from "./mentions.ts";

describe("splitIntegrationMentions", () => {
  it("finds a mention at the start, mid-sentence and before punctuation", () => {
    expect(splitIntegrationMentions("@Outline find the roadmap, then ask @outline.")).toEqual([
      { kind: "mention", start: 0, text: "@Outline", integrationId: "outline" },
      { kind: "text", start: 8, text: " find the roadmap, then ask " },
      { kind: "mention", start: 36, text: "@outline", integrationId: "outline" },
      { kind: "text", start: 44, text: "." },
    ]);
  });

  it("leaves emails, longer words and unknown names as text", () => {
    for (const text of ["mail me@Outline.com", "see @Outlines", "ask @Notion", "no mention"])
      expect(splitIntegrationMentions(text)).toEqual([{ kind: "text", start: 0, text }]);
  });

  it("joins back to the input", () => {
    const text = "line one\n@Outline\n\n  @Outline twice";
    expect(
      splitIntegrationMentions(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });
});
