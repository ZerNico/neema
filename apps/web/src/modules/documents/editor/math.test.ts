import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { documentSchema, normalizeMarkdown, parseMarkdown, toMarkdown } from "./markdown.ts";

/** The nodes a Markdown string reads as, by type, with math's LaTeX. */
const shape = (markdown: string) => {
  const out: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "inlineMath" || node.type === "blockMath")
      out.push(`${node.type}:${String(node.attrs?.latex)}`);
    else if (node.type === "text") out.push(`text:${node.text}`);
    node.content?.forEach(walk);
  };
  walk(parseMarkdown(markdown).toJSON() as JSONContent);
  return out;
};

describe("math in document Markdown", () => {
  it("reads inline and display formulas, and writes them back as it read them", () => {
    const markdown =
      "The weight $w_i$ of criterion $i$.\n\n$$\nN_j = \\sum_{i=1}^{n} w_i s_{ij}\n$$";
    expect(shape(markdown)).toEqual([
      "text:The weight ",
      "inlineMath:w_i",
      "text: of criterion ",
      "inlineMath:i",
      "text:.",
      "blockMath:N_j = \\sum_{i=1}^{n} w_i s_{ij}",
    ]);
    expect(normalizeMarkdown(markdown)).toBe(markdown);
  });

  it("leaves prices as text", () => {
    expect(shape("It costs $5 and $10, or $ 20 $ in all.")).toEqual([
      "text:It costs $5 and $10, or $ 20 $ in all.",
    ]);
  });

  it("reads the $$…$$ models write mid-sentence as inline, and alone on a line as display", () => {
    expect(shape("where $$w_i$$ is the weight")).toEqual([
      "text:where ",
      "inlineMath:w_i",
      "text: is the weight",
    ]);
    expect(shape("$$N_j = x$$")).toEqual(["blockMath:N_j = x"]);
  });

  it("escapes a typed dollar that would open math, so the text stays text", () => {
    const typed = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [documentSchema.text("Use $x$ here, from $5 to $10")]),
    ]);
    const markdown = toMarkdown(typed);
    expect(markdown).toBe("Use \\$x$ here, from $5 to $10");
    expect(shape(markdown)).toEqual(["text:Use $x$ here, from $5 to $10"]);
  });

  it("keeps dollars in code as written", () => {
    expect(shape("`$x$` stays code")).toEqual(["text:$x$", "text: stays code"]);
    expect(normalizeMarkdown("```\n$x$\n```")).toBe("```\n$x$\n```");
  });
});
