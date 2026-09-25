import { describe, expect, it } from "vitest";
import { taskProgress } from "./task-items.ts";

describe("task progress", () => {
  it("counts the stored tasks, nested ones included, and how many are done", () => {
    expect(taskProgress("# Plan\n\n- [ ] first\n  - [x] nested\n- [x] last")).toEqual({
      done: 2,
      total: 3,
    });
  });

  it("ignores task lines inside code, and prose with brackets", () => {
    const markdown = "- [ ] real\n\n````md\n```\n- [x] example\n```\n````\n\nnot a task [ ]";
    expect(taskProgress(markdown)).toEqual({ done: 0, total: 1 });
  });

  it("has none to report without tasks", () => {
    expect(taskProgress("Just prose.")).toBeNull();
  });
});
