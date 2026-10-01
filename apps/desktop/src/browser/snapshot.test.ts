import { describe, expect, it } from "vitest";
import { serializeAxTree, type AxNode } from "./snapshot.ts";

const node = (nodeId: string, role: string, name: string, extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const page: AxNode[] = [
  node("1", "RootWebArea", "Example", { childIds: ["2", "3", "6", "8"] }),
  node("2", "heading", "Welcome", {
    parentId: "1",
    childIds: ["2t"],
    properties: [{ name: "level", value: { value: 1 } }],
  }),
  node("2t", "StaticText", "Welcome", { parentId: "2" }),
  node("3", "generic", "", { parentId: "1", childIds: ["4", "5"] }),
  node("4", "StaticText", "Some   text here", { parentId: "3" }),
  node("5", "link", "Sign in", { parentId: "3", backendDOMNodeId: 41, childIds: ["5t"] }),
  node("5t", "StaticText", "Sign in", { parentId: "5" }),
  node("6", "textbox", "Search", {
    parentId: "1",
    backendDOMNodeId: 42,
    value: { value: "cats" },
    properties: [{ name: "focused", value: { value: true } }],
  }),
  node("8", "button", "Hidden", { parentId: "1", ignored: true, childIds: ["9"] }),
  node("9", "checkbox", "Remember me", {
    parentId: "8",
    backendDOMNodeId: 43,
    properties: [{ name: "checked", value: { value: "true" } }],
  }),
];

describe("serializeAxTree", () => {
  it("outlines what matters, with references for what can be acted on", () => {
    const { text, truncated, refs } = serializeAxTree(page);
    expect(text).toBe(
      [
        '- heading 1 "Welcome"',
        "Some text here",
        '- [e1] link "Sign in"',
        '- [e2] textbox "Search": cats (focused)',
        '- [e3] checkbox "Remember me" (checked)',
      ].join("\n"),
    );
    expect(truncated).toBe(false);
    expect([...refs]).toEqual([
      ["e1", 41],
      ["e2", 42],
      ["e3", 43],
    ]);
  });

  it("cuts a long page short and says so", () => {
    const many: AxNode[] = [
      node("r", "RootWebArea", "", { childIds: Array.from({ length: 50 }, (_, i) => `p${i}`) }),
      ...Array.from({ length: 50 }, (_, i) =>
        node(`p${i}`, "paragraph", `Paragraph number ${i}`, { parentId: "r" }),
      ),
    ];
    const { text, truncated } = serializeAxTree(many, 300);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(360);
    expect(text.endsWith("this outline was cut short)")).toBe(true);
  });
});
