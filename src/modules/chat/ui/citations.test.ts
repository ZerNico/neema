import { describe, expect, it } from "vitest";
import {
  citedSourceIndexes,
  collectSources,
  prepareCitedMarkdown,
  selectAnswerSources,
} from "./citations.ts";
import type { ToolActivity, ToolSource } from "../client/use-message-stream.ts";

const source = (index: number, url: string): ToolSource => ({
  index,
  url,
  title: `Title ${index}`,
  snippet: "",
  read: true,
});

const webActivity = (callId: string, sources?: ToolSource[]): ToolActivity => ({
  family: "web",
  callId,
  name: "web_search",
  targets: [],
  status: "complete",
  ...(sources ? { sources } : {}),
});

describe("prepareCitedMarkdown", () => {
  it("leaves content untouched when there are no sources", () => {
    expect(prepareCitedMarkdown("plain [^1] text", [])).toBe("plain [^1] text");
  });

  it("appends a definition per source so markers resolve while streaming", () => {
    const out = prepareCitedMarkdown("Effect 4 is out[^1].", [source(1, "https://effect.website")]);
    expect(out).toContain("Effect 4 is out[^1].");
    expect(out).toContain("[^1]: https://effect.website");
  });

  it("drops a half-streamed trailing marker", () => {
    const out = prepareCitedMarkdown("Released in 2026[^1", [source(1, "https://a.dev")]);
    expect(out).toContain("Released in 2026\n");
    expect(out).not.toContain("2026[^1\n");
  });

  it("closes an unterminated code fence so definitions don't land inside it", () => {
    const out = prepareCitedMarkdown("See[^1]:\n\n```ts\nconst a = 1", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("See[^1]:\n\n```ts\nconst a = 1\n```\n\n[^1]: https://a.dev");
  });

  it("leaves a closed code fence alone", () => {
    const out = prepareCitedMarkdown("```ts\nconst a = 1\n```\nDone[^1].", [
      source(1, "https://a.dev"),
    ]);
    expect(out).toBe("```ts\nconst a = 1\n```\nDone[^1].\n\n[^1]: https://a.dev");
  });

  it("drops markers with no matching source", () => {
    const out = prepareCitedMarkdown("Claim[^9] and claim[^1].", [source(1, "https://a.dev")]);
    expect(out).toContain("Claim and claim[^1].");
  });
});

describe("answer evidence selection", () => {
  it("includes own cited or extracted evidence and only cited inherited evidence", () => {
    const own = [
      source(1, "https://a.dev"),
      { ...source(2, "https://b.dev"), read: false },
      { ...source(3, "https://c.dev"), read: false },
    ];
    const inherited = [source(4, "https://d.dev"), source(5, "https://e.dev")];
    expect(
      selectAnswerSources("Claim[^2] and prior finding[^4].", own, inherited).map((s) => s.index),
    ).toEqual([1, 2, 4]);
    expect(selectAnswerSources("No cited evidence.", [own[1]!], inherited)).toEqual([]);
  });

  it.each([
    "`[^2]`",
    "`` example ` [^2] ``",
    "```md\n[^2]\n```",
    "~~~md\n[^2]\n~~~",
    "    [^2]",
    "> ```md\n> [^2]\n> ```",
    "[^2]: definition containing [^3]",
    "\\[^2]",
    "```md\nunterminated [^2]",
  ])("does not count example code or definitions as citations: %s", (example) => {
    expect([...citedSourceIndexes(`Claim[^1].\n\n${example}`)]).toEqual([1]);
  });

  it("counts prose in blockquotes/lists and ignores half-streamed markers", () => {
    expect([...citedSourceIndexes("> Claim[^2]\n\n- Another[^3]\n\nHalf[^4")]).toEqual([2, 3]);
  });
});

describe("collectSources", () => {
  it("merges web activities, dedupes by index and sorts", () => {
    const merged = collectSources([
      webActivity("one", [source(2, "https://b.dev"), source(1, "https://a.dev")]),
      webActivity("two", [source(2, "https://b.dev"), source(3, "https://c.dev")]),
      webActivity("three"),
    ]);
    expect(merged.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("ignores memory activities even if malformed input carries sources", () => {
    const malformedMemory = {
      family: "memory",
      callId: "memory-1",
      name: "save_memory",
      status: "complete",
      outcome: "created",
      sources: [source(9, "https://should-never-appear.dev")],
    } as ToolActivity;

    expect(
      collectSources([malformedMemory, webActivity("web", [source(1, "https://a.dev")])]),
    ).toEqual([source(1, "https://a.dev")]);
  });
});
