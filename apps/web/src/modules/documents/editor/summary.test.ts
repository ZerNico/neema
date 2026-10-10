import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown.ts";
import { summarize } from "./summary.ts";

describe("a document's summary", () => {
  it("counts the tasks, nested ones included, and how many are done", () => {
    const doc = parseMarkdown("# Plan\n\n- [ ] first\n  - [x] nested\n- [x] last");
    expect(summarize(doc)).toMatchObject({ tasksDone: 2, tasksTotal: 3 });
  });

  it("counts no task lines inside code, nor prose with brackets", () => {
    const doc = parseMarkdown("- [ ] real\n\n```md\n- [x] example\n```\n\nnot a task [ ]");
    expect(summarize(doc)).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
  });

  it("measures the text a person wrote, without Markdown syntax", () => {
    expect(summarize(parseMarkdown("# Title\n\n**bold** text")).textLength).toBe(
      "Titlebold text".length,
    );
  });
});
