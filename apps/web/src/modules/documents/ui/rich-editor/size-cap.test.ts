import { EditorState } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { documentSchema } from "../../editor/markdown.ts";
import { overCap, treeSize } from "../../editor/limits.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";
import { capCheck } from "./size-cap.ts";

const check = capCheck(treeSize);
const stateOf = (...inline: Node[]) =>
  EditorState.create({
    doc: documentSchema.node("doc", null, [documentSchema.node("paragraph", null, inline)]),
  });
const allowed = (state: EditorState, change: (tr: EditorState["tr"]) => EditorState["tr"]) =>
  check(change(state.tr), state.doc);
const formula = (length: number) =>
  documentSchema.node("inlineMath", { latex: "x".repeat(length) });

describe("size cap", () => {
  it("refuses text past the limit and lets a deletion through", () => {
    const state = stateOf(documentSchema.text("x".repeat(DOCUMENT_LIMITS.chars - 4)));
    const end = state.doc.content.size - 1;
    expect(allowed(state, (tr) => tr.insertText("abcd", end))).toBe(true);
    expect(allowed(state, (tr) => tr.insertText("abcde", end))).toBe(false);
    expect(allowed(state, (tr) => tr.delete(end - 2, end))).toBe(true);
  });

  it("refuses a formula's LaTeX growing past the hidden-data budget, though the tree does not grow", () => {
    const state = stateOf(formula(1));
    const grown = (tr: EditorState["tr"]) =>
      tr.setNodeMarkup(1, undefined, { latex: "x".repeat(DOCUMENT_LIMITS.chars + 1) });
    expect(grown(state.tr).doc.content.size).toBe(state.doc.content.size);
    expect(allowed(state, grown)).toBe(false);
  });

  it("lets a document already over a limit shrink, but not grow", () => {
    const state = stateOf(formula(DOCUMENT_LIMITS.chars + 10), documentSchema.text("ab"));
    expect(overCap(state.doc)).toBe("document holds too much hidden data");
    const end = state.doc.content.size - 1;
    expect(allowed(state, (tr) => tr.delete(end - 1, end))).toBe(true);
    // Text is under its own limit, so typing more of it makes nothing worse.
    expect(allowed(state, (tr) => tr.insertText("c", end))).toBe(true);
    expect(
      allowed(state, (tr) =>
        tr.setNodeMarkup(1, undefined, { latex: "x".repeat(DOCUMENT_LIMITS.chars + 11) }),
      ),
    ).toBe(false);
  });

  it("counts blocks that hold no text", () => {
    const empty = documentSchema.node("paragraph");
    const doc = documentSchema.node(
      "doc",
      null,
      Array.from({ length: 5_001 }, () => empty),
    );
    expect(overCap(doc)).toBe(`document exceeds ${DOCUMENT_LIMITS.blocks} blocks`);
  });
});
