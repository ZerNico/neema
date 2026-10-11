import { describe, expect, it } from "vitest";
import { cellStyle, isStylePatch, patchStyle, restyle, styleKey } from "./style.ts";

describe("cell edges", () => {
  it("takes a line style and a colour, and nothing else", () => {
    expect(isStylePatch({ borderTop: { style: "thick", color: "#FF0000" } })).toBe(true);
    expect(isStylePatch({ borderLeft: { style: "double" }, borderRight: null })).toBe(true);
    expect(isStylePatch({ borderTop: true })).toBe(false);
    expect(isStylePatch({ borderTop: { style: "wavy" } })).toBe(false);
    expect(isStylePatch({ borderTop: { style: "thin", color: "red" } })).toBe(false);
    expect(isStylePatch({ borderTop: { style: "thin", width: 4 } })).toBe(false);
  });

  it("writes one key for a line whatever order its parts came in", () => {
    const a = styleKey({ borderTop: { style: "dashed", color: "#00FF00" } });
    const b = styleKey({ borderTop: { color: "#00FF00", style: "dashed" } } as never);
    expect(a).toBe(b);
    expect(patchStyle(a, { borderTop: { color: "#00FF00", style: "dashed" } as never })).toBe(a);
    expect(restyle(a, { borderTop: { color: "#00FF00", style: "dashed" } as never })).toBeNull();
    expect(restyle(a, { borderTop: { style: "dashed" } })).toEqual({
      borderTop: { style: "dashed" },
    });
  });

  it("reads an edge stored as on, before edges had lines, as a thin one", () => {
    expect(cellStyle('{"borderBottom":true,"bold":true}')).toEqual({
      borderBottom: { style: "thin" },
      bold: true,
    });
  });
});
