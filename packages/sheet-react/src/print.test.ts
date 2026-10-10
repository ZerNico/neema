import { describe, expect, it } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { emptyDoc } from "@chat/sheet/model";
import { printHtml } from "./print.ts";

describe("printing a sheet", () => {
  it("prints the used range as shown, leaving out hidden and collapsed rows", () => {
    const doc = applyChange(
      emptyDoc(),
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: "Item <1>" },
              { r: "s1.r2", c: "s1.c1", v: "Hidden" },
              { r: "s1.r3", c: "s1.c1", v: "Folded" },
              { r: "s1.r4", c: "s1.c2", v: 0.5 },
            ],
          },
          {
            op: "format",
            sh: "s1",
            area: { r1: "s1.r4", r2: "s1.r4", c1: "s1.c2", c2: "s1.c2" },
            patch: { numberFormat: "0%" },
          },
          { op: "hide", sh: "s1", axis: "rows", ids: ["s1.r2"], hidden: true },
          {
            op: "outline",
            sh: "s1",
            axis: "rows",
            list: [{ from: "s1.r3", to: "s1.r3", collapsed: true }],
          },
        ],
      },
      1,
    ).doc;
    const values = calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 });
    const html = printHtml({ doc, values, locale: EN_US }, "s1")!;
    expect(html).toContain("Item &lt;1&gt;");
    expect(html).toContain("50%");
    expect(html).not.toContain("Hidden");
    expect(html).not.toContain("Folded");
    expect((html.match(/<tr>/g) ?? []).length).toBe(2);
    expect((html.match(/<col /g) ?? []).length).toBe(2);
    expect(printHtml({ doc: emptyDoc(), values, locale: EN_US }, "s1")).toBeNull();
    // No page margin, so the browser adds no header or footer of its own.
    expect(html).toContain("@page { margin: 0; }");
  });

  it("prints a merge as one cell over its shown rows and columns", () => {
    const doc = applyChange(
      emptyDoc(),
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: "Title" },
              { r: "s1.r3", c: "s1.c4", v: "x" },
            ],
          },
          { op: "merge", sh: "s1", box: { r1: "s1.r1", r2: "s1.r2", c1: "s1.c1", c2: "s1.c3" } },
          { op: "hide", sh: "s1", axis: "columns", ids: ["s1.c2"], hidden: true },
        ],
      },
      1,
    ).doc;
    const values = calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 });
    const html = printHtml({ doc, values, locale: EN_US }, "s1")!;
    expect(html).toMatch(/<td colspan="2" rowspan="2"[^>]*>Title<\/td>/);
    // Shown columns A, C and D; the merge takes two of them over two rows, counted once.
    expect(html.match(/<td/g)).toHaveLength(6);
  });
});
