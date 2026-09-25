import { describe, expect, it } from "vitest";
import { readPartialObject } from "./partial-json.ts";

const read = (raw: string) => Object.fromEntries(readPartialObject(raw));

describe("readPartialObject", () => {
  it("reads complete string fields and the one still arriving", () => {
    expect(read('{"documentId": "d1", "old": "- [ ] ship", "new": "- [x] sh')).toEqual({
      documentId: { value: "d1", complete: true },
      old: { value: "- [ ] ship", complete: true },
      new: { value: "- [x] sh", complete: false },
    });
  });

  it("decodes escapes and holds back one that has not fully arrived", () => {
    expect(read('{"new": "line\\nnext \\"quoted\\" \\u00e9')).toEqual({
      new: { value: 'line\nnext "quoted" é', complete: false },
    });
    expect(read('{"new": "tail\\')).toEqual({ new: { value: "tail", complete: false } });
    expect(read('{"new": "e\\u00')).toEqual({ new: { value: "e", complete: false } });
  });

  it("skips numbers, nulls and nested values, keeping the strings after them", () => {
    expect(
      read('{"expectedRevision": 3, "x": null, "y": {"a": ["}", 1]}, "old": "a", "new": "b"}'),
    ).toEqual({
      old: { value: "a", complete: true },
      new: { value: "b", complete: true },
    });
  });

  it("returns nothing for input that is not an object yet", () => {
    expect(read("")).toEqual({});
    expect(read('  {"ol')).toEqual({});
    expect(read("[1, 2]")).toEqual({});
  });
});
