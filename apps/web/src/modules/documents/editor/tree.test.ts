import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";
import { adoptIds, blockIdOf, ensureIds, findBlocks } from "./block-ids.ts";
import { documentSchema, parseMarkdown, replaceDifference, toMarkdown } from "./markdown.ts";
import { blockHash, blockView } from "./tree.ts";

let counter = 0;
const mint = () => `b${++counter}`;
const withIds = (markdown: string) => {
  counter = 0;
  return ensureIds(new Transform(parseMarkdown(markdown)), mint).doc;
};

describe("block IDs", () => {
  it("gives every block an ID and repeats a fresh one", () => {
    const doc = withIds("# Plan\n\n- one\n- two\n\nText");
    const ids: string[] = [];
    doc.descendants((node) => {
      const id = blockIdOf(node);
      if (id) ids.push(id);
      return true;
    });
    expect(ids).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7"]);
    // Splitting "Text" copies its paragraph's ID onto the second half.
    const split = new Transform(doc).split(doc.content.size - 3);
    expect(blockIdOf(split.doc.lastChild!)).toBe(
      blockIdOf(split.doc.child(split.doc.childCount - 2)),
    );
    counter = 100;
    const repaired = ensureIds(split, mint).doc;
    expect(findBlocks(repaired, "b7")).toHaveLength(1);
    expect(blockIdOf(repaired.lastChild!)).toBe("b101");
  });

  it("fingerprints attributes as well as text", () => {
    const doc = withIds("- [ ] ship");
    const ticked = new Transform(doc).setNodeAttribute(1, "checked", true).doc;
    expect(blockHash(ticked.child(0))).not.toBe(blockHash(doc.child(0)));
    expect(blockHash(withIds("- [ ] ship").child(0))).toBe(blockHash(doc.child(0)));
  });
});

describe("writing Markdown into a tree with IDs", () => {
  const ids = (doc: ReturnType<typeof withIds>) => {
    const found: (string | null)[] = [];
    doc.forEach((block) => found.push(blockIdOf(block)));
    return found;
  };

  it("keeps the IDs of blocks it did not change, and of one changed in place", () => {
    const doc = withIds("# Plan\n\nFirst\n\nSecond\n\nLast");
    const before = ids(doc);
    const next = adoptIds(doc, parseMarkdown("# Plan\n\nFirst edited\n\nNew\n\nSecond\n\nLast"));
    const after = ids(next);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after.slice(-2)).toEqual(before.slice(-2));
    expect(after[2]).toBeNull();
    // Written as the smallest change: one step, inside the edited paragraph and the new one.
    const tr = replaceDifference(
      new Transform(doc),
      parseMarkdown("# Plan\n\nFirst edited\n\nSecond\n\nLast"),
    );
    expect(tr.steps).toHaveLength(1);
    expect(ids(tr.doc)).toEqual(before);
  });

  it("keeps an empty paragraph someone may be typing into", () => {
    const base = withIds("Intro\n\nOutro");
    const typing = new Transform(base).insert(
      base.content.size,
      documentSchema.node("paragraph", { id: "typing" }),
    ).doc;
    const tr = replaceDifference(new Transform(typing), parseMarkdown("Intro changed\n\nOutro"));
    expect(blockIdOf(tr.doc.lastChild!)).toBe("typing");
    expect(toMarkdown(tr.doc)).toBe("Intro changed\n\nOutro");
  });
});

describe("block view", () => {
  it("shows every block with its ID and text as inline Markdown", () => {
    const doc = withIds(
      [
        "## Goals",
        "",
        "Ship **fast** & <safely>",
        "",
        "- one",
        "- two",
        "",
        "- [x] done",
        "",
        "```ts",
        "a < b",
        "```",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "---",
      ].join("\n"),
    );
    const view = blockView(doc, { budget: 10_000 });
    expect(view.xml.split("\n")).toEqual([
      '<h2 id="b1">Goals</h2>',
      '<p id="b2">Ship **fast** &amp; &lt;safely&gt;</p>',
      '<ul id="b3"><li id="b4">one</li><li id="b6">two</li></ul>',
      '<tasks id="b8"><task id="b9" checked="true">done</task></tasks>',
      '<code id="b11" lang="ts">a &lt; b</code>',
      '<table id="b12">',
      "| a   | b   |",
      "| --- | --- |",
      "| 1   | 2   |",
      "</table>",
      // Paragraphs inside the table's cells hold b13 to b16.
      '<hr id="b17"/>',
    ]);
    expect(view.next).toBeUndefined();
    expect(view.seen.map((block) => block.id)).toContain("b5");
  });

  it("shows a planned section and writes no Markdown for it", () => {
    const doc = documentSchema.node("doc", null, [
      documentSchema.node("heading", { level: 1, id: "t" }, [documentSchema.text("Brief")]),
      documentSchema.node("pending", { id: "p1", intent: 'Scope & "goals"' }),
    ]);
    expect(blockView(doc, { budget: 1_000 }).xml).toBe(
      '<h1 id="t">Brief</h1>\n<pending id="p1" intent="Scope &amp; &quot;goals&quot;"/>',
    );
    expect(toMarkdown(doc)).toBe("# Brief");
  });

  it("windows a long document by block and continues without gaps", () => {
    const doc = withIds(Array.from({ length: 10 }, (_, index) => `Line ${index}`).join("\n\n"));
    const first = blockView(doc, { budget: 70 });
    expect(first.xml.split("\n")).toEqual([
      '<p id="b1">Line 0</p>',
      '<p id="b2">Line 1</p>',
      '<p id="b3">Line 2</p>',
      '<gap blocks="7"/>',
    ]);
    expect(first.next).toEqual({ fromBlock: "b4" });
    const second = blockView(doc, { budget: 70, fromBlock: "b4" });
    expect(second.xml.split("\n")[0]).toBe('<gap blocks="3"/>');
    expect(second.xml.split("\n")[1]).toBe('<p id="b4">Line 3</p>');
    expect(second.seen.map((block) => block.id)).toEqual(["b4", "b5", "b6"]);
  });

  it("cuts a block larger than the window and never counts it as seen", () => {
    const doc = withIds(`${"x".repeat(150)}\n\nAfter`);
    const first = blockView(doc, { budget: 60 });
    expect(first.xml).toMatch(/^<part of="b1" from="0" truncated="true"><p id="b1">x+<\/part>$/);
    expect(first.seen).toEqual([]);
    expect(first.next).toEqual({ fromBlock: "b1", fromCharacter: 60 });
    const last = blockView(doc, { budget: 200, ...first.next! });
    expect(last.xml).toMatch(/^<part of="b1" from="60">x+<\/p><\/part>\n<gap blocks="1"\/>$/);
    expect(last.next).toEqual({ fromBlock: "b2" });
  });
});
