import { describe, expect, it } from "vitest";
import { listTaskItems, toggleTaskItem } from "./task-items.ts";

const source = [
  "# Plan",
  "",
  "- [ ] first",
  "  - [x] nested",
  "1. [ ] numbered",
  "2) [X] paren",
  "* not a task [ ]",
  "+ [ ] plus",
  "\t- [ ] tabbed",
].join("\n");

describe("task items", () => {
  it("counts ordinals across nested, numbered and tabbed items, skipping prose", () => {
    expect(listTaskItems(source)).toEqual([
      { line: 2, checked: false },
      { line: 3, checked: true },
      { line: 4, checked: false },
      { line: 5, checked: true },
      { line: 7, checked: false },
      { line: 8, checked: false },
    ]);
  });

  it("rewrites exactly the addressed line", () => {
    const toggled = toggleTaskItem(source, 2, true)!;
    const before = source.split("\n");
    const after = toggled.split("\n");
    expect(after[4]).toBe("1. [x] numbered");
    expect(after.filter((line, i) => line !== before[i])).toEqual(["1. [x] numbered"]);
    expect(toggleTaskItem(source, 3, false)!.split("\n")[5]).toBe("2) [ ] paren");
    expect(toggleTaskItem(source, 1, true)).toBe(source);
  });

  it("preserves CRLF endings and refuses an ordinal out of range", () => {
    expect(toggleTaskItem("- [ ] a\r\n- [ ] b\r\n", 1, true)).toBe("- [ ] a\r\n- [x] b\r\n");
    expect(toggleTaskItem(source, 6, true)).toBeNull();
    expect(toggleTaskItem("", 0, true)).toBeNull();
  });
});
