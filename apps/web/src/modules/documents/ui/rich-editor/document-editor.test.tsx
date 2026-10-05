import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { readMarkdown, writeMarkdown } from "../../editor/markdown.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";
import DocumentEditor, { type DocumentEditorMode } from "./document-editor.tsx";
import { linkTarget, openLink } from "./links.ts";
import { filterSlashItems, SLASH_ITEMS } from "./slash-command.tsx";
import { fittingControls } from "./fitting-controls.ts";

beforeAll(() => {
  // jsdom lays nothing out; ProseMirror measures the selection to scroll it into view.
  // An element's empty list stands in: jsdom has one there, not on ranges.
  Range.prototype.getClientRects = () => document.createElement("div").getClientRects();
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** Stands in for the panel's actions row, which the editor puts its toolbar in. */
const slot = () => document.body.appendChild(document.createElement("div"));

const replica = (markdown = "") => {
  const doc = new Y.Doc();
  if (markdown) writeMarkdown(doc, markdown);
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name: "Ada", color: "#3b82f6" });
  return { doc, awareness };
};

const mount = (
  sync: ReturnType<typeof replica>,
  { mode = "live", readOnly = false }: { mode?: DocumentEditorMode; readOnly?: boolean } = {},
) => render(<DocumentEditor sync={sync} mode={mode} readOnly={readOnly} toolbarSlot={slot()} />);

/** Text inside a link, as a click on it would land. */
const anchor = (href: string) => {
  const link = document.body.appendChild(document.createElement("a"));
  link.setAttribute("href", href);
  return link.appendChild(document.createElement("span"));
};
const click = (target: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("click", { bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
};

/** Tiptap keeps its editor on the editable element, which is how tests reach commands. */
const editorOf = async (label = "Document") => {
  const surface = await screen.findByRole("textbox", { name: label });
  return (surface as HTMLElement & { editor: Editor }).editor;
};

describe("document editor", () => {
  it("shows the shared tree formatted and writes the toolbar's formats into it", async () => {
    const sync = replica("Ship it today");
    mount(sync);
    const editor = await editorOf();
    expect(screen.getByRole("textbox", { name: "Document" })).toHaveTextContent("Ship it today");

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 8 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(readMarkdown(sync.doc)).toBe("**Ship it** today");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(readMarkdown(sync.doc)).toBe("- [ ] **Ship it** today");
  });

  it("ticks a task from its checkbox", async () => {
    const sync = replica("- [ ] write notes\n- [ ] ship");
    mount(sync);
    await editorOf();
    const [first] = screen.getAllByRole("checkbox");
    fireEvent.click(first!);
    expect(readMarkdown(sync.doc)).toBe("- [x] write notes\n- [ ] ship");
  });

  it("stops ticking tasks once the person may no longer edit", async () => {
    const sync = replica("- [ ] ship");
    const toolbar = slot();
    const { rerender } = render(
      <DocumentEditor sync={sync} mode="live" readOnly={false} toolbarSlot={toolbar} />,
    );
    await editorOf();
    rerender(<DocumentEditor sync={sync} mode="live" readOnly toolbarSlot={toolbar} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(readMarkdown(sync.doc)).toBe("- [ ] ship");
  });

  it("inserts a table from the / menu's item", async () => {
    const sync = replica("Intro");
    mount(sync);
    const editor = await editorOf();
    const [table] = filterSlashItems("grid");
    expect(table?.title).toBe("Table");
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "/tab");
      const end = editor.state.selection.from;
      table!.run(editor, { from: end - 4, to: end });
    });
    expect(readMarkdown(sync.doc)).toMatch(/^Intro\n\n\| +\| +\| +\|\n\| -{3} \| -{3} \| -{3} \|/);
    expect(filterSlashItems("")).toBe(SLASH_ITEMS);
    expect(filterSlashItems("nothing like this")).toEqual([]);
  });

  it("promotes the next row when the header row is deleted, as the Markdown does", async () => {
    const sync = replica("| Area | Owner |\n| --- | --- |\n| Editor | Ada |\n| Sync | Grace |");
    mount(sync);
    const editor = await editorOf();
    let area = -1;
    editor.state.doc.descendants((node, position) => {
      if (area < 0 && node.isText && node.text === "Area") area = position;
    });
    act(() => {
      editor.chain().focus().setTextSelection(area).deleteRow().run();
    });
    expect(readMarkdown(sync.doc)).toBe(
      "| Editor | Ada   |\n| ------ | ----- |\n| Sync   | Grace |",
    );
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Editor", "Ada"]);
  });

  it("keeps two people's editors on one document in step", async () => {
    const one = replica("# Plan");
    const two = replica();
    // Stands in for the server relaying each side's updates to the other.
    one.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "relay") Y.applyUpdate(two.doc, update, "relay");
    });
    two.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "relay") Y.applyUpdate(one.doc, update, "relay");
    });
    Y.applyUpdate(two.doc, Y.encodeStateAsUpdate(one.doc), "relay");
    render(
      <>
        <section aria-label="First">
          <DocumentEditor sync={one} mode="live" readOnly={false} toolbarSlot={slot()} />
        </section>
        <section aria-label="Second">
          <DocumentEditor sync={two} mode="live" readOnly={false} toolbarSlot={slot()} />
        </section>
      </>,
    );
    const [first, second] = (await screen.findAllByRole("textbox", { name: "Document" })).map(
      (surface) => (surface as HTMLElement & { editor: Editor }).editor,
    );
    act(() => {
      first!.commands.insertContentAt(first!.state.doc.content.size, "<p>From one</p>");
      second!.commands.insertContentAt(1, "Draft ");
    });
    expect(readMarkdown(one.doc)).toBe("# Draft Plan\n\nFrom one");
    expect(readMarkdown(two.doc)).toBe(readMarkdown(one.doc));
    expect(second!.getText()).toContain("From one");
  });

  it("gives a viewer the document without a way to change it", async () => {
    const sync = replica("- [ ] ship");
    mount(sync, { readOnly: true });
    const editor = await editorOf();
    expect(editor.isEditable).toBe(false);
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Document" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("shows the Markdown as stored, following the tree", async () => {
    const sync = replica("# Plan");
    mount(sync, { mode: "source" });
    expect(screen.getByLabelText("Document Markdown")).toHaveTextContent("# Plan");
    act(() => writeMarkdown(sync.doc, "# Plan\n\n- [ ] ship"));
    expect(screen.getByLabelText("Document Markdown").textContent).toBe("# Plan\n\n- [ ] ship");
  });

  it("never renders a script address the Markdown carries as a link", async () => {
    mount(replica("[bad](javascript:alert(1)) and [ok](https://example.test)"), {
      readOnly: true,
    });
    await editorOf();
    expect(screen.getByText("ok").closest("a")).toHaveAttribute("href", "https://example.test");
    expect(screen.getByText("bad").closest("a")?.getAttribute("href") ?? "").not.toMatch(
      /javascript/i,
    );
  });

  it("refuses typing past the size cap, but not a collaborator's text", async () => {
    const full = "x".repeat(DOCUMENT_LIMITS.chars - 3);
    const sync = replica(full);
    mount(sync);
    const editor = await editorOf();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "abc");
    });
    expect(readMarkdown(sync.doc)).toBe(`${full}abc`);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "d");
    });
    expect(readMarkdown(sync.doc)).toBe(`${full}abc`);
    // What the server accepted from someone else is shown whatever its size.
    act(() => writeMarkdown(sync.doc, `${full}abcdef`));
    expect(editor.getText()).toBe(`${full}abcdef`);
  });

  it("puts its formatting in the panel's actions row, and none for a viewer", async () => {
    const toolbar = slot();
    const sync = replica("Plan");
    const { rerender } = render(
      <DocumentEditor sync={sync} mode="live" readOnly={false} toolbarSlot={toolbar} />,
    );
    await editorOf();
    expect(within(toolbar).getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    rerender(<DocumentEditor sync={sync} mode="live" readOnly toolbarSlot={toolbar} />);
    expect(within(toolbar).queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("is one Tab stop, with arrow keys moving between its controls", async () => {
    mount(replica("Plan"));
    await editorOf();
    const toolbar = screen.getByRole("toolbar", { name: "Formatting" });
    const reachable = within(toolbar)
      .getAllByRole("button")
      .filter((button) => button.tabIndex === 0);
    expect(reachable).toHaveLength(1);
    const [first] = reachable;
    act(() => first!.focus());
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    // Focus follows the roving index once it has re-rendered.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Bold" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Italic" })),
    );
  });

  it("folds what does not fit into More, keeping a slot for it", () => {
    expect(fittingControls(0, 14)).toBe(14);
    expect(fittingControls(14 * 34, 14)).toBe(14);
    expect(fittingControls(14 * 34 - 1, 14)).toBe(12);
    expect(fittingControls(4 * 34 + 10, 14)).toBe(3);
    expect(fittingControls(20, 14)).toBe(0);
  });

  it("opens a link on Cmd or Ctrl click while editing, and on any click for a viewer", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const inside = anchor("https://example.test/a");
    expect(openLink(true, click(inside))).toBe(false);
    expect(openLink(true, click(inside, { metaKey: true }))).toBe(true);
    expect(openLink(true, click(inside, { ctrlKey: true }))).toBe(true);
    expect(openLink(false, click(inside))).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.test/a", "_blank", "noopener,noreferrer");
    expect(openLink(false, click(anchor("javascript:alert(1)")))).toBe(false);
    expect(openLink(true, click(document.body, { metaKey: true }))).toBe(false);
    expect(open).toHaveBeenCalledTimes(3);
    open.mockRestore();
  });

  it("links only to web and mail addresses", () => {
    expect(linkTarget("example.test/page")).toBe("https://example.test/page");
    expect(linkTarget("mailto:ada@example.test")).toBe("mailto:ada@example.test");
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("data:text/html,x")).toBeNull();
    expect(linkTarget("   ")).toBeNull();
  });
});
