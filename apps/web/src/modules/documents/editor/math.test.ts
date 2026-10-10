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

  it("escapes every typed dollar, so the text stays text", () => {
    const typed = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [documentSchema.text("Use $x$ here, from $5 to $10")]),
    ]);
    const markdown = toMarkdown(typed);
    expect(markdown).toBe("Use \\$x\\$ here, from \\$5 to \\$10");
    expect(shape(markdown)).toEqual(["text:Use $x$ here, from $5 to $10"]);
  });

  it("keeps a typed dollar pair split by formatting as text", () => {
    const bold = documentSchema.marks.bold!.create();
    const typed = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [
        documentSchema.text("$"),
        documentSchema.text("x", [bold]),
        documentSchema.text("$"),
      ]),
    ]);
    const markdown = toMarkdown(typed);
    expect(markdown).toBe("\\$**x**\\$");
    expect(shape(markdown)).toEqual(["text:$", "text:x", "text:$"]);
  });

  it("writes a formula a digit follows so it reads back as one", () => {
    const doc = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [
        documentSchema.text("a "),
        documentSchema.node("inlineMath", { latex: "x" }),
        documentSchema.text("2"),
      ]),
    ]);
    const markdown = toMarkdown(doc);
    expect(markdown).toBe("a $$x$$2");
    expect(shape(markdown)).toEqual(["text:a ", "inlineMath:x", "text:2"]);
    expect(normalizeMarkdown("a $$x$$2")).toBe("a $$x$$2");
  });

  it("keeps dollars in code as written", () => {
    expect(shape("`$x$` stays code")).toEqual(["text:$x$", "text: stays code"]);
    expect(normalizeMarkdown("```\n$x$\n```")).toBe("```\n$x$\n```");
  });
});
