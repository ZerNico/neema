import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";
import { blockIdOf, ensureIds } from "./block-ids.ts";
import { parseMarkdown, toMarkdown } from "./markdown.ts";
import { applyTreeEdit, type TreeEdit } from "./tree-edit.ts";
import { blockView } from "./tree.ts";

let counter = 0;
const mint = () => `b${++counter}`;
const withIds = (markdown: string) => {
  counter = 0;
  return ensureIds(new Transform(parseMarkdown(markdown)), mint).doc;
};
/** Everything the view shows, as an edit would have seen it. */
const seenAll = (doc: ReturnType<typeof withIds>) =>
  new Map(blockView(doc, { budget: 100_000 }).seen.map((block) => [block.id, block.hash]));
const apply = (doc: ReturnType<typeof withIds>, edit: TreeEdit, seen = seenAll(doc)) => {
  const result = applyTreeEdit(doc, edit, seen);
  if ("outcome" in result) return result;
  return { markdown: toMarkdown(result.tr.doc), doc: result.tr.doc, touched: result.touched };
};

const DOC = "# Plan\n\nIntro text\n\n- one\n- two\n\nOutro";
// b1 heading, b2 intro, b3 list, b4 item one, b5 its paragraph, b6 item two, b7 paragraph, b8 outro

describe("edits aimed at blocks", () => {
  it("replaces one block, keeping its ID when the type stays", () => {
    const doc = withIds(DOC);
    const result = apply(doc, {
      kind: "blocks",
      target: "b2",
      position: "replace",
      content: "New **intro**",
    });
    if ("outcome" in result) throw new Error(result.message);
    expect(result.markdown).toBe("# Plan\n\nNew **intro**\n\n- one\n- two\n\nOutro");
    expect(blockIdOf(result.doc.child(1))).toBe("b2");
    expect(result.touched).toEqual(["b2"]);
  });

  it("inserts before and after, giving new blocks IDs", () => {
    const doc = withIds(DOC);
    const after = apply(doc, {
      kind: "blocks",
      target: "b1",
      position: "after",
      content: "## Goals\n\nShip",
    });
    if ("outcome" in after) throw new Error(after.message);
    expect(after.markdown).toBe(
      "# Plan\n\n## Goals\n\nShip\n\nIntro text\n\n- one\n- two\n\nOutro",
    );
    expect(after.touched).toHaveLength(2);
    expect(after.touched.every((id) => !/^b\d$/.test(id) || Number(id.slice(1)) > 8)).toBe(true);
  });

  it("adds a list item next to an item, from Markdown list syntax", () => {
    const doc = withIds(DOC);
    const result = apply(doc, {
      kind: "blocks",
      target: "b6",
      position: "after",
      content: "- three",
    });
    if ("outcome" in result) throw new Error(result.message);
    expect(result.markdown).toBe("# Plan\n\nIntro text\n\n- one\n- two\n- three\n\nOutro");
  });

  it("replaces a range and deletes, taking an emptied list with it", () => {
    const doc = withIds(DOC);
    const range = apply(doc, {
      kind: "blocks",
      target: "b2",
      through: "b3",
      position: "replace",
      content: "Merged",
    });
    if ("outcome" in range) throw new Error(range.message);
    expect(range.markdown).toBe("# Plan\n\nMerged\n\nOutro");
    const items = apply(doc, { kind: "blocks", target: "b4", through: "b6", position: "replace" });
    if ("outcome" in items) throw new Error(items.message);
    expect(items.markdown).toBe("# Plan\n\nIntro text\n\nOutro");
  });

  it("plants a planned section and fills it later", () => {
    const doc = withIds(DOC);
    const planted = apply(doc, {
      kind: "blocks",
      target: "b1",
      position: "after",
      pending: "Goals and scope",
    });
    if ("outcome" in planted) throw new Error(planted.message);
    expect(blockView(planted.doc, { budget: 10_000 }).xml).toContain('intent="Goals and scope"');
    const pendingId = planted.touched[0]!;
    const filled = apply(planted.doc, {
      kind: "blocks",
      target: pendingId,
      position: "replace",
      content: "## Goals\n\nShip it",
    });
    if ("outcome" in filled) throw new Error(filled.message);
    expect(filled.markdown).toBe(
      "# Plan\n\n## Goals\n\nShip it\n\nIntro text\n\n- one\n- two\n\nOutro",
    );
  });

  it("refuses a block the model has not seen, or that changed since", () => {
    const doc = withIds(DOC);
    const edit: TreeEdit = { kind: "blocks", target: "b2", position: "replace", content: "x" };
    expect(apply(doc, edit, new Map())).toMatchObject({ outcome: "conflict" });
    const seen = seenAll(doc);
    const typed = new Transform(doc).insert(
      doc.child(0).nodeSize + 2,
      doc.type.schema.text("!"),
    ).doc;
    expect(apply(typed, edit, seen)).toMatchObject({ outcome: "conflict" });
    // Inserting next to a block needs no reading of it.
    expect(
      apply(typed, { kind: "blocks", target: "b2", position: "after", content: "y" }, seen),
    ).not.toHaveProperty("outcome");
  });

  it("names missing, repeated and mismatched targets", () => {
    const doc = withIds(DOC);
    expect(
      apply(doc, { kind: "blocks", target: "nope", position: "replace", content: "x" }),
    ).toMatchObject({ outcome: "not_found" });
    expect(
      apply(doc, {
        kind: "blocks",
        target: "b2",
        through: "b4",
        position: "replace",
        content: "x",
      }),
    ).toMatchObject({ outcome: "invalid" });
    const twice = new Transform(doc).setNodeAttribute(doc.child(0).nodeSize, "id", "b1").doc;
    expect(
      apply(twice, { kind: "blocks", target: "b1", position: "replace", content: "x" }),
    ).toMatchObject({ outcome: "ambiguous" });
  });
});

describe("edits by text", () => {
  it("changes text inside one block as the smallest step", () => {
    const doc = withIds(DOC);
    const result = applyTreeEdit(
      doc,
      { kind: "find", find: "Intro", content: "Short intro" },
      null,
    );
    if ("outcome" in result) throw new Error(result.message);
    expect(toMarkdown(result.tr.doc)).toBe("# Plan\n\nShort intro text\n\n- one\n- two\n\nOutro");
    expect(result.tr.steps).toHaveLength(1);
    expect(blockIdOf(result.tr.doc.child(1))).toBe("b2");
  });

  it("matches the Markdown the model reads, and narrows by target", () => {
    const doc = withIds("A **bold** word\n\nAnother **bold** word");
    expect(
      applyTreeEdit(doc, { kind: "find", find: "**bold**", content: "*soft*" }, null),
    ).toMatchObject({ outcome: "ambiguous" });
    const narrowed = applyTreeEdit(
      doc,
      { kind: "find", target: "b2", find: "**bold**", content: "*soft*" },
      null,
    );
    if ("outcome" in narrowed) throw new Error(narrowed.message);
    expect(toMarkdown(narrowed.tr.doc)).toBe("A **bold** word\n\nAnother *soft* word");
  });

  it("reports text that is not there or crosses blocks", () => {
    const doc = withIds(DOC);
    expect(applyTreeEdit(doc, { kind: "find", find: "missing", content: "x" }, null)).toMatchObject(
      { outcome: "no_match" },
    );
    expect(
      applyTreeEdit(doc, { kind: "find", find: "text\n\n- one", content: "x" }, null),
    ).toMatchObject({
      outcome: "no_match",
      message: expect.stringContaining("one block"),
    });
  });
});
