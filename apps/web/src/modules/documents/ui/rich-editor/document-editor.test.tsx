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
import { fittingControls } from "./fitting-controls.ts";

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
    act(() => {
      editor.chain().focus().setTextSelection(textAt("Sync")).run();
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
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
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
    expect(within(toolbar).getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    rerender(<DocumentEditor sync={sync} readOnly toolbarSlot={toolbar} />);
    expect(within(toolbar).queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("is one Tab stop, with arrow keys moving between its controls", async () => {
    mount(await replica("Plan"));
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
