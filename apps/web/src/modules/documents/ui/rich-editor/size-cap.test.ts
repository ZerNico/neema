import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { documentSchema } from "../../editor/markdown.ts";
import { overCap } from "../../editor/limits.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";
import { capCheck } from "./size-cap.ts";

const near = "x".repeat(DOCUMENT_LIMITS.chars - 4);
let state = EditorState.create({
  doc: documentSchema.node("doc", null, [
    documentSchema.node("paragraph", null, [documentSchema.text(near)]),
  ]),
});
const apply = (
  check: ReturnType<typeof capCheck>,
  change: (s: EditorState) => EditorState["tr"],
) => {
  const transaction = change(state);
  const allowed = check(transaction, state.doc);
  if (allowed) state = state.apply(transaction);
  return allowed;
};

describe("size cap", () => {
  it("measures what grows the tree, refuses past the limit, and lets shrinking through", () => {
    let measured = 0;
    const check = capCheck((doc) => {
      measured++;
      return overCap(doc) === null;
    });
    const end = () => state.doc.content.size - 1;
    expect(apply(check, (s) => s.tr.insertText("abcd", end()))).toBe(true);
    expect(apply(check, (s) => s.tr.insertText("e", end()))).toBe(false);
    expect(measured).toBe(2);
    expect(apply(check, (s) => s.tr.delete(end() - 2, end()))).toBe(true);
    expect(measured).toBe(2);
    expect(state.doc.textContent).toBe(`${near}ab`);
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
