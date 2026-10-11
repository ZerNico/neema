import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeDocumentServer,
  freshDocumentDevice,
} from "../../../../../tests/fixtures/document-server.ts";
import { DocumentSync } from "../../client/document-sync.ts";
import { outbox } from "../../client/outbox.ts";
import { toMarkdown } from "../../editor/markdown.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";
import DocumentEditor from "./document-editor.tsx";
import { sortColumn } from "./table-sort.ts";
import { linkTarget, openLink } from "./links.ts";
import { filterSlashItems, SLASH_ITEMS } from "./slash-command.tsx";
import { browserEditorExtensions, browserEditorProps } from "./editor-extensions.ts";

beforeAll(() => {
  // jsdom lays nothing out; ProseMirror measures the selection to scroll it into view.
  // An element's empty list stands in: jsdom has one there, not on ranges.
  Range.prototype.getClientRects = () => document.createElement("div").getClientRects();
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
let server: ReturnType<typeof fakeDocumentServer>;
const connections = new Set<DocumentSync>();
beforeEach(async () => {
  await freshDocumentDevice();
  server = fakeDocumentServer();
});
afterEach(() => {
  cleanup();
  for (const sync of connections) sync.destroy();
  connections.clear();
  document.body.replaceChildren();
});

/** Stands in for the panel's actions row, which the editor puts its toolbar in. */
const slot = () => document.body.appendChild(document.createElement("div"));

let seeded = 0;
/** Seeds a document on the fake server, unless one is named, and connects an editor to it. */
const replica = async (markdown = "", documentId?: string) => {
  const id = documentId ?? `document-${++seeded}`;
  if (!documentId)
    server.seed({
      id,
      conversationId: "conversation",
      projectId: null,
      title: "Plan",
      content: markdown,
      revision: 0,
      lastEditedBy: "model",
      canEdit: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  const sync = new DocumentSync({
    documentId: id,
    push: (data) => server.push({ data }),
    connect: (url) => new server.EventSource(url),
    extensions: browserEditorExtensions,
    editorProps: browserEditorProps,
    outbox,
    user: { name: "Ada", color: "#3b82f6", colorLight: "#3b82f633" },
  });
  connections.add(sync);
  await waitFor(() => expect(sync.editor).not.toBeNull());
  return { id, sync, editor: sync.editor!, markdown: () => toMarkdown(sync.editor!.state.doc) };
};
type Replica = Awaited<ReturnType<typeof replica>>;

const mount = (sync: Replica, { readOnly = false }: { readOnly?: boolean } = {}) =>
  render(<DocumentEditor sync={sync} readOnly={readOnly} toolbarSlot={slot()} />);

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
    const sync = await replica("Ship it today");
    mount(sync);
    const editor = await editorOf();
    expect(screen.getByRole("textbox", { name: "Document" })).toHaveTextContent("Ship it today");

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 8 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(sync.markdown()).toBe("**Ship it** today");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Checklist" }));
    expect(sync.markdown()).toBe("- [ ] **Ship it** today");
  });

  it("draws a formula with KaTeX and edits its LaTeX from the field it opens", async () => {
    const sync = await replica("Weight $w_i$ here");
    mount(sync);
    const editor = await editorOf();
    const surface = screen.getByRole("textbox", { name: "Document" });
    await waitFor(() => expect(surface.querySelector(".katex")).not.toBeNull());
    expect(screen.queryByRole("textbox", { name: "LaTeX" })).toBeNull();

    // Selecting the formula, as a click does, opens its LaTeX.
    act(() => {
      editor.commands.setNodeSelection(8);
    });
    const field = await screen.findByRole("textbox", { name: "LaTeX" });
    expect(field).toHaveValue("w_i");
    fireEvent.change(field, { target: { value: "w_j^2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "LaTeX" })).toBeNull());
    expect(sync.markdown()).toBe("Weight $w_j^2$ here");

    // Emptied, the formula goes.
    act(() => {
      editor.commands.setNodeSelection(8);
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "LaTeX" }), {
      target: { value: " " },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX" }), { key: "Enter" });
    await waitFor(() => expect(sync.markdown()).toBe("Weight  here"));
  });

  it("leaves a collaborator's change to a formula alone when its field closes untouched", async () => {
    const sync = await replica("Weight $w_i$ here");
    mount(sync);
    const editor = await editorOf();
    const other = await replica("", sync.id);
    act(() => {
      editor.commands.setNodeSelection(8);
    });
    const field = await screen.findByRole("textbox", { name: "LaTeX" });
    act(() => {
      other.editor.commands.command(({ tr }) => {
        tr.setNodeMarkup(8, undefined, { latex: "w_k" });
        return true;
      });
    });
    // The field follows the change while nothing has been typed into it.
    await waitFor(() => expect(field).toHaveValue("w_k"));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "LaTeX" })).toBeNull());
    await waitFor(() => expect(server.content(sync.id)).toBe("Weight $w_k$ here"));
    expect(sync.markdown()).toBe("Weight $w_k$ here");
  });

  it("replaces a selection across blocks with the formula it becomes", async () => {
    const sync = await replica("Area\n\ndef");
    mount(sync);
    const editor = await editorOf();
    act(() => {
      // From the end of "Area" into "def": the formula takes "de".
      editor.commands.setTextSelection({ from: 5, to: 9 });
    });
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Formula" }));
    const field = await screen.findByRole("textbox", { name: "LaTeX" });
    await waitFor(() => expect(field).toHaveValue("de"));
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sync.markdown()).toBe("Area$de$f"));
  });

  it("inserts a formula from the toolbar, inline in text and on its own line when empty", async () => {
    const sync = await replica("Area is pi r^2\n\n");
    mount(sync);
    const editor = await editorOf();
    // Selected text becomes the LaTeX, and the field opens on it.
    act(() => {
      editor.commands.setTextSelection({ from: 9, to: 15 });
    });
    // Formulas are on the ribbon's Insert tab.
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Formula" }));
    const field = await screen.findByRole("textbox", { name: "LaTeX" });
    expect(field).toHaveValue("pi r^2");
    fireEvent.change(field, { target: { value: "\\pi r^2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(sync.markdown()).toBe("Area is $\\pi r^2$"));

    // In an empty paragraph it is a display formula.
    act(() => {
      editor.chain().focus("end").insertContent({ type: "paragraph" }).run();
    });
    fireEvent.click(screen.getByRole("button", { name: "Formula" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "LaTeX" }), {
      target: { value: "E = mc^2" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX" }), { key: "Enter" });
    await waitFor(() => expect(sync.markdown()).toBe("Area is $\\pi r^2$\n\n$$\nE = mc^2\n$$"));
  });

  it("ticks a task from its checkbox", async () => {
    const sync = await replica("- [ ] write notes\n- [ ] ship");
    mount(sync);
    await editorOf();
    const [first] = screen.getAllByRole("checkbox");
    fireEvent.click(first!);
    expect(sync.markdown()).toBe("- [x] write notes\n- [ ] ship");
  });

  it("stops ticking tasks once the person may no longer edit", async () => {
    const sync = await replica("- [ ] ship");
    const toolbar = slot();
    const { rerender } = render(
      <DocumentEditor sync={sync} readOnly={false} toolbarSlot={toolbar} />,
    );
    await editorOf();
    rerender(<DocumentEditor sync={sync} readOnly toolbarSlot={toolbar} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(sync.markdown()).toBe("- [ ] ship");
  });

  it("inserts a table from the / menu's item", async () => {
    const sync = await replica("Intro");
    mount(sync);
    const editor = await editorOf();
    const [table] = filterSlashItems("grid");
    expect(table?.title).toBe("Table");
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "/tab");
      const end = editor.state.selection.from;
      table!.run(editor, { from: end - 4, to: end });
    });
    expect(sync.markdown()).toMatch(/^Intro\n\n\| +\| +\| +\|\n\| -{3} \| -{3} \| -{3} \|/);
    expect(filterSlashItems("")).toBe(SLASH_ITEMS);
    expect(filterSlashItems("nothing like this")).toEqual([]);
  });

  it("keeps a table without a header row, and toggles one back", async () => {
    const sync = await replica(
      "| Area | Owner |\n| --- | --- |\n| Editor | Ada |\n| Sync | Grace |",
    );
    mount(sync);
    const editor = await editorOf();
    let area = -1;
    editor.state.doc.descendants((node, position) => {
      if (area < 0 && node.isText && node.text === "Area") area = position;
    });
    act(() => {
      editor.chain().focus().setTextSelection(area).deleteRow().run();
    });
    // The tree keeps it headerless; Markdown, which needs a header line, writes its first row there.
    expect(screen.queryAllByRole("columnheader")).toEqual([]);
    expect(sync.markdown()).toBe("| Editor | Ada   |\n| ------ | ----- |\n| Sync   | Grace |");
    act(() => {
      editor.chain().focus().toggleHeaderRow().run();
    });
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual(["Editor", "Ada"]);
  });

  it("sorts every row of a table without a header row", async () => {
    const sync = await replica(
      "| Area | Owner |\n| --- | --- |\n| Sync | Grace |\n| Editor | Ada |",
    );
    mount(sync);
    const editor = await editorOf();
    const textAt = (text: string) => {
      let found = -1;
      editor.state.doc.descendants((node, position) => {
        if (found < 0 && node.isText && node.text === text) found = position;
      });
      return found;
    };
    act(() => {
      editor.chain().focus().setTextSelection(textAt("Area")).deleteRow().run();
    });
    // A header column is not a header row: its first cell alone is a header.
    act(() => {
      editor.chain().focus().setTextSelection(textAt("Sync")).toggleHeaderColumn().run();
    });
    act(() => {
      editor.chain().focus().setTextSelection(textAt("Grace")).run();
      sortColumn(editor, 1);
    });
    expect(sync.markdown()).toBe("| Editor | Ada   |\n| ------ | ----- |\n| Sync   | Grace |");
  });

  it("keeps two people's editors on one document in step", async () => {
    const one = await replica("# Plan");
    const two = await replica("", one.id);
    render(
      <>
        <section aria-label="First">
          <DocumentEditor sync={one} readOnly={false} toolbarSlot={slot()} />
        </section>
        <section aria-label="Second">
          <DocumentEditor sync={two} readOnly={false} toolbarSlot={slot()} />
        </section>
      </>,
    );
    // Both type before either has heard of the other's change: the server
    // orders them and the later one rebases.
    act(() => {
      one.editor.commands.insertContentAt(one.editor.state.doc.content.size, "<p>From one</p>");
      two.editor.commands.insertContentAt(1, "Draft ");
    });
    await waitFor(() => expect(one.markdown()).toBe("# Draft Plan\n\nFrom one"));
    await waitFor(() => expect(two.markdown()).toBe(one.markdown()));
    expect(server.content(one.id)).toBe("# Draft Plan\n\nFrom one");
  });

  it("gives a viewer the document without a way to change it", async () => {
    const sync = await replica("- [ ] ship");
    mount(sync, { readOnly: true });
    const editor = await editorOf();
    expect(editor.isEditable).toBe(false);
    expect(screen.queryByRole("toolbar", { name: "History" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Document" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("never renders a script address the Markdown carries as a link", async () => {
    mount(await replica("[bad](javascript:alert(1)) and [ok](https://example.test)"), {
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
    const sync = await replica(full);
    mount(sync);
    const editor = await editorOf();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "abc");
    });
    expect(sync.markdown()).toBe(`${full}abc`);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "d");
    });
    expect(sync.markdown()).toBe(`${full}abc`);
    // What the server accepted from someone else is shown whatever its size.
    await waitFor(() => expect(server.content(sync.id)).toBe(`${full}abc`));
    act(() => server.editElsewhere(sync.id, () => `${full}abcdef`));
    expect(editor.getText()).toBe(`${full}abcdef`);
  });

  it("puts its formatting in the panel's actions row, and none for a viewer", async () => {
    const toolbar = slot();
    const sync = await replica("Plan");
    const { rerender } = render(
      <DocumentEditor sync={sync} readOnly={false} toolbarSlot={toolbar} />,
    );
    await editorOf();
    expect(within(toolbar).getByRole("toolbar", { name: "History" })).toBeInTheDocument();
    rerender(<DocumentEditor sync={sync} readOnly toolbarSlot={toolbar} />);
    expect(within(toolbar).queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("keeps Undo and Redo one Tab stop, with arrow keys moving between them", async () => {
    mount(await replica("Plan"));
    await editorOf();
    const toolbar = screen.getByRole("toolbar", { name: "History" });
    const reachable = within(toolbar)
      .getAllByRole("button")
      .filter((button) => button.tabIndex === 0);
    expect(reachable).toHaveLength(1);
    const [first] = reachable;
    act(() => first!.focus());
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    // Focus follows the roving index once it has re-rendered; Undo and Redo
    // come first and stay reachable while there is nothing to undo.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Undo" })),
    );
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(toolbar).getByRole("button", { name: "Redo" })),
    );
  });

  it("finds the selected words and replaces every match in one undoable step", async () => {
    const sync = await replica("Ship the plan.\n\nThe **plan** ships Friday.");
    mount(sync);
    const editor = await editorOf();
    act(() => {
      editor.commands.setTextSelection({ from: 10, to: 14 });
    });
    // Mod is Ctrl off a Mac, which jsdom is.
    fireEvent.keyDown(editor.view.dom, { key: "f", ctrlKey: true });
    const query = await screen.findByRole("textbox", { name: "Find in document" });
    expect(query).toHaveValue("plan");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    fireEvent.change(query, { target: { value: "ship" } });
    expect(screen.getByText(/of 2/)).toBeInTheDocument();
    // Replacing comes with the ribbon's button, and keeps each match's formatting.
    fireEvent.change(query, { target: { value: "plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Find and replace" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Replace with" }), {
      target: { value: "roadmap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() =>
      expect(server.content(sync.id)).toBe("Ship the roadmap.\n\nThe **roadmap** ships Friday."),
    );
    act(() => {
      editor.commands.undo();
    });
    expect(sync.markdown()).toBe("Ship the plan.\n\nThe **plan** ships Friday.");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in document" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("counts words under the text and jumps to a heading from the outline", async () => {
    const sync = await replica("# Plan\n\nShip it soon\n\n## Risks\n\nNone yet");
    mount(sync);
    const editor = await editorOf();
    expect(screen.getByRole("status", { name: "Word count" })).toHaveTextContent(
      "7 words · 29 characters",
    );
    act(() => {
      editor.commands.setTextSelection({ from: 7, to: 14 });
    });
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Word count" })).toHaveTextContent("2 of 7 words"),
    );
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Outline" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Risks" }));
    await waitFor(() => expect(editor.state.selection.$from.parent.textContent).toBe("Risks"));
    // Hidden from the View tab, and remembered on this device.
    fireEvent.click(screen.getByRole("button", { name: "Word count" }));
    expect(screen.queryByRole("status", { name: "Word count" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Word count" }));
  });

  it("inserts callouts, footnotes and foldable sections, folding only for this reader", async () => {
    const sync = await replica("Back up first");
    mount(sync);
    const editor = await editorOf();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Callout" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Warning" }));
    await waitFor(() => expect(sync.markdown()).toBe("> [!WARNING]\n> Back up first"));

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    });
    fireEvent.click(screen.getByRole("button", { name: "Footnote" }));
    const note = await screen.findByRole("textbox", { name: "Footnote" });
    fireEvent.change(note, { target: { value: "Per the runbook." } });
    fireEvent.keyDown(note, { key: "Enter" });
    await waitFor(() =>
      expect(sync.markdown()).toBe(
        "> [!WARNING]\n> Back up first[^1]\n\n[^1]: Per the runbook.",
      ),
    );

    act(() => {
      editor.commands.focus("end");
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapsible section" }));
    act(() => {
      editor.commands.insertContent("Steps");
    });
    await waitFor(() => expect(sync.markdown()).toContain("<summary>Steps</summary>"));
    const before = sync.markdown();
    fireEvent.click(screen.getByRole("button", { name: "Fold section" }));
    expect(screen.getByRole("button", { name: "Unfold section" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(sync.markdown()).toBe(before);
  });

  it("keeps inserting and reviewing on their own tabs, as the sheet's ribbon does", async () => {
    const sync = await replica("Plan the launch");
    mount(sync);
    const editor = await editorOf();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Divider" }));
    await waitFor(() => expect(sync.markdown()).toContain("---"));
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    // A comment needs text to sit on.
    expect(await screen.findByRole("button", { name: "New comment" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New comment" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
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
