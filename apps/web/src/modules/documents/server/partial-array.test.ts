import { describe, expect, it } from "vitest";
import { readPartialArray } from "./partial-json.ts";

describe("reading an array that is still arriving", () => {
  it("returns the elements already complete and the text of the next", () => {
    const raw =
      '{"documentId":"d","operations":[{"kind":"addSheet","name":"A]"},{"kind":"setCells","sheet":"A","start":"A1","rows":[[1,"x]"],[2';
    const { complete, partial } = readPartialArray(raw, "operations");
    expect(complete).toEqual([{ kind: "addSheet", name: "A]" }]);
    expect(partial).toMatch(/^\{"kind":"setCells"/);
    // The same reader finds the rows already written inside that element.
    expect(readPartialArray(partial!, "rows")).toEqual({ complete: [[1, "x]"]], partial: "[2" });
  });

  it("reads bare values and stops at the array's end", () => {
    expect(readPartialArray('{"rows":[1, true ,null],"x":[9]}', "rows")).toEqual({
      complete: [1, true, null],
      partial: null,
    });
  });
});
