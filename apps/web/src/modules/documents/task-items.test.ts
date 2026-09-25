import { describe, expect, it } from "vitest";
import { listTaskItems, taskMarkerOffset } from "./task-items.ts";

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

  it("points at the marker character of exactly the addressed task", () => {
    const marker = (ordinal: number) => source[taskMarkerOffset(source, ordinal)!];
    expect(marker(0)).toBe(" ");
    expect(marker(1)).toBe("x");
    expect(marker(3)).toBe("X");
    const offset = taskMarkerOffset(source, 2)!;
    const ticked = `${source.slice(0, offset)}x${source.slice(offset + 1)}`;
    const before = source.split("\n");
    expect(ticked.split("\n").filter((line, i) => line !== before[i])).toEqual(["1. [x] numbered"]);
  });

  it("counts CRLF lines and refuses an ordinal out of range", () => {
    const crlf = "- [ ] a\r\n- [ ] b\r\n";
    expect(taskMarkerOffset(crlf, 1)).toBe(crlf.lastIndexOf("[ ]") + 1);
    expect(taskMarkerOffset(source, 6)).toBeNull();
    expect(taskMarkerOffset("", 0)).toBeNull();
  });
});
