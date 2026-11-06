import { describe, expect, test } from "vitest";
import { buildOutline, RefBook } from "./outline.ts";
import type { Look, UiNode } from "./protocol.ts";

const node = (id: string, depth: number, fields: Partial<UiNode> = {}): UiNode => ({
  id,
  depth,
  role: "group",
  actions: [],
  ...fields,
});

const look = (nodes: UiNode[], fields: Partial<Look> = {}): Look => ({
  app: "Calculator",
  title: "Calculator",
  window: { width: 200, height: 400 },
  image: { data: "", width: 200, height: 400 },
  nodes,
  truncated: false,
  ...fields,
});

describe("the outline of a look", () => {
  test("numbers what is worth showing and maps each reference to its node", () => {
    const outline = buildOutline(
      look([
        node("n1", 0, { role: "window", name: "Calculator" }),
        // An unnamed group with no action adds nothing; its children move up a level.
        node("n2", 1),
        node("n3", 2, { role: "text", value: "‎42" }),
        node("n4", 2, {
          role: "button",
          name: "7",
          actions: ["press"],
          frame: { x: 10, y: 200, width: 40, height: 40 },
        }),
        node("n5", 1, { role: "closeButton", actions: ["press"], disabled: true }),
      ]),
    );
    expect(outline.text).toBe(
      [
        'e1 window "Calculator"',
        '  e2 text = "42"',
        '  e3 button "7" @30,220',
        "  e4 closeButton disabled",
      ].join("\n"),
    );
    expect([...outline.refs]).toEqual([
      ["e1", "n1"],
      ["e2", "n3"],
      ["e3", "n4"],
      ["e4", "n5"],
    ]);
    expect(outline.truncated).toBe(false);
  });

  test("gives positions in picture pixels", () => {
    const outline = buildOutline(
      look(
        [
          node("n1", 0, {
            role: "button",
            name: "Save",
            actions: ["press"],
            frame: { x: 100, y: 50, width: 20, height: 10 },
          }),
        ],
        { image: { data: "", width: 100, height: 200 } },
      ),
    );
    expect(outline.text).toBe('e1 button "Save" @55,28');
  });

  test("leaves out what is scrolled out of the window, with everything inside it", () => {
    const outline = buildOutline(
      look([
        node("n1", 0, { role: "window" }),
        node("n2", 1, { role: "list", frame: { x: 0, y: 500, width: 200, height: 100 } }),
        node("n3", 2, { role: "listItem", name: "Hidden" }),
        node("n4", 1, { role: "button", name: "Shown", actions: ["press"] }),
      ]),
    );
    expect(outline.text).toBe('e1 window\n  e2 button "Shown"');
  });

  test("stops at its budget and says so", () => {
    // Many rows of a few cells each, so the budget and not the per-element cap stops it.
    const nodes = [node("n0", 0, { role: "table" })];
    for (let row = 0; row < 20; row++) {
      nodes.push(node(`r${row}`, 1, { role: "row", name: `row ${row}` }));
      for (let cell = 0; cell < 20; cell++)
        nodes.push(
          node(`c${row}-${cell}`, 2, { role: "cell", value: `${"x".repeat(30)} ${row}:${cell}` }),
        );
    }
    const outline = buildOutline(look(nodes));
    expect(outline.truncated).toBe(true);
    expect(outline.text.length).toBeLessThanOrEqual(12_000);
    expect(outline.refs.size).toBe(outline.text.split("\n").length);
  });

  test("shows a long list's first items and counts the rest, so what follows still shows", () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      node(`i${index}`, 2, { role: "link", name: `chat ${index}`, actions: ["press"] }),
    );
    const outline = buildOutline(
      look([
        node("n1", 0, { role: "window" }),
        node("n2", 1, { role: "list" }),
        ...items,
        // In the same run of siblings, as Chromium lays a page out.
        node("n4", 2, { role: "textArea", name: "Message", actions: ["setValue"] }),
        node("n3", 1, { role: "button", name: "Send", actions: ["press"] }),
      ]),
    );
    const lines = outline.text.split("\n");
    expect(lines.filter((line) => line.includes(`link "`))).toHaveLength(25);
    expect(outline.text).toContain("    … 35 more link (scroll or zoom to see them)");
    expect(outline.text).toMatch(/textArea "Message"/);
    expect(lines.at(-1)).toMatch(/button "Send"/);
    expect(outline.truncated).toBe(false);
  });

  test("leaves out nameless groups and text that repeats its parent's name", () => {
    const outline = buildOutline(
      look([
        node("n1", 0, { role: "window" }),
        node("n2", 1, { role: "group", actions: ["press"] }),
        node("n3", 2, { role: "link", name: "New chat", actions: ["press"] }),
        node("n4", 3, { role: "text", value: "New chat" }),
        node("n5", 3, { role: "text", value: "⌘N" }),
      ]),
    );
    expect(outline.text).toBe('e1 window\n  e2 link "New chat"\n    e3 text = "⌘N"');
  });

  test("passes on the driver's own truncation", () => {
    expect(
      buildOutline(look([node("n1", 0, { role: "window" })], { truncated: true })).truncated,
    ).toBe(true);
  });

  test("shortens long names and keeps quotes readable", () => {
    const outline = buildOutline(
      look([node("n1", 0, { role: "text", value: `say "hi"\n${"a".repeat(200)}` })]),
    );
    const line = outline.text;
    expect(line.startsWith('e1 text = "say \\"hi\\" aaa')).toBe(true);
    expect(line.endsWith('…"')).toBe(true);
  });

  test("keeps an element's reference across looks, and gives a changed one a new one", () => {
    const button = (id: string, name: string, x: number) =>
      node(id, 1, {
        role: "button",
        name,
        actions: ["press"],
        frame: { x, y: 100, width: 40, height: 40 },
      });
    const book = new RefBook();
    const first = buildOutline(
      look([node("n1", 0, { role: "window" }), button("n2", "AC", 0), button("n3", "7", 50)]),
      book,
    );
    // Pressing AC renames it and the driver numbers its nodes afresh.
    const second = buildOutline(
      look([node("m1", 0, { role: "window" }), button("m2", "C", 0), button("m3", "7", 50)]),
      book,
    );
    const refOf = (outline: ReturnType<typeof buildOutline>, id: string) =>
      [...outline.refs].find(([, nodeId]) => nodeId === id)?.[0];
    expect(refOf(second, "m3")).toBe(refOf(first, "n3"));
    expect(refOf(second, "m2")).not.toBe(refOf(first, "n2"));
    expect(second.refs.has(refOf(first, "n2")!)).toBe(false);
  });

  test("gives two elements alike their own references, look after look", () => {
    const row = (id: string) => node(id, 1, { role: "text", value: "Same" });
    const book = new RefBook();
    const refsOf = (outline: ReturnType<typeof buildOutline>) => [...outline.refs.keys()];
    const first = refsOf(
      buildOutline(look([node("n1", 0, { role: "window" }), row("n2"), row("n3")]), book),
    );
    const second = refsOf(
      buildOutline(look([node("m1", 0, { role: "window" }), row("m2"), row("m3")]), book),
    );
    expect(second).toEqual(first);
  });

  test("gives the same button in another app its own reference", () => {
    const close = node("n2", 1, {
      role: "closeButton",
      actions: ["press"],
      frame: { x: 10, y: 10, width: 12, height: 12 },
    });
    const book = new RefBook();
    const first = buildOutline(look([node("n1", 0, { role: "window" }), close]), book);
    const other = buildOutline(
      look([node("n1", 0, { role: "window" }), close], { app: "TextEdit" }),
      book,
    );
    expect([...other.refs.keys()]).not.toContain([...first.refs.keys()][1]);
  });
});
