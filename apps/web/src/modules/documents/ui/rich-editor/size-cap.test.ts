import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { documentSchema, toMarkdown } from "../../editor/markdown.ts";
import { capCheck } from "./size-cap.ts";

// Large enough that the check measures at all.
const text = "x".repeat(30_000);
let state = EditorState.create({
  doc: documentSchema.node("doc", null, [
    documentSchema.node("paragraph", null, [documentSchema.text(text)]),
  ]),
});
const typing = (check: ReturnType<typeof capCheck>, typed: string) => {
  const transaction = state.tr.insertText(typed, state.doc.content.size - 1);
  const allowed = check(transaction, state.doc);
  if (allowed) state = state.apply(transaction);
  return allowed;
};

describe("size cap", () => {
  it("measures only when growth could reach the cap, and refuses past it", () => {
    let measured = 0;
    const measure = (doc: Parameters<typeof toMarkdown>[0]) => {
      measured++;
      return toMarkdown(doc).length;
    };
    const check = capCheck(measure, text.length + 20);
    expect(typing(check, "a")).toBe(true);
    expect(measured).toBe(1);
    // Four more characters fit within the bound, so nothing is serialized.
    for (const letter of "bcd") expect(typing(check, letter)).toBe(true);
    expect(measured).toBe(1);
    // Near the cap every step is measured, and the one past it is refused.
    expect(typing(check, "0123456789abcdefg")).toBe(false);
    expect(measured).toBe(2);
    expect(toMarkdown(state.doc)).toBe(`${text}abcd`);
  });
});
