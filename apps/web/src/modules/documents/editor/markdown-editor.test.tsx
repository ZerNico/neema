import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import { documentExtensions } from "./extensions.ts";

it("uses document block discovery when the editor imports and replaces Markdown", () => {
  const prefix = Array.from({ length: 1_000 }, (_, i) => `Paragraph ${i}`).join("\n\n");
  const section =
    "<details>\n<summary>Totals</summary>\n\n> [!NOTE]\n> Read the table.\n\nThe rest.\n\n</details>";
  const editor = new Editor({
    extensions: documentExtensions,
    content: `${prefix}\n${section}`,
    contentType: "markdown",
  });
  try {
    const doc = editor.state.doc;
    doc.check();
    expect(doc.childCount).toBe(1_001);
    const details = doc.lastChild!;
    expect(details.type.name).toBe("details");
    expect(details.firstChild!.textContent).toBe("Totals");
    expect(details.lastChild!.child(0).type.name).toBe("callout");
    expect(details.lastChild!.child(1).textContent).toBe("The rest.");
    expect(editor.getMarkdown()).toContain(section);

    editor.commands.setContent("Before\n> [!TIP]\n> Next\n\nAfter", { contentType: "markdown" });
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("callout");
    expect(editor.state.doc.child(1).attrs.kind).toBe("tip");
  } finally {
    editor.destroy();
  }
});
