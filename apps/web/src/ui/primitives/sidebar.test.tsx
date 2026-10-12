import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fakeDocumentServer,
  freshDocumentDevice,
} from "../../../tests/fixtures/document-server.ts";
import { DocumentSync } from "~/modules/documents/client/document-sync.ts";
import { outbox } from "~/modules/documents/client/outbox.ts";
import { toMarkdown } from "~/modules/documents/editor/markdown.ts";
import DocumentEditor from "~/modules/documents/ui/rich-editor/document-editor.tsx";
import {
  browserEditorExtensions,
  browserEditorProps,
} from "~/modules/documents/ui/rich-editor/editor-extensions.ts";
import { SidebarProvider, useSidebar } from "./sidebar.tsx";

vi.mock("~/modules/documents/server/document-functions.ts", () => ({
  getDocument: vi.fn(),
  listDocuments: vi.fn(),
  listProjectDocuments: vi.fn(),
  getDocumentVersions: vi.fn(),
  getDocumentVersion: vi.fn(),
  addDocumentImage: vi.fn(),
}));

function State() {
  return <output aria-label="Sidebar state">{useSidebar().state}</output>;
}
const shortcut = (target: EventTarget, init: KeyboardEventInit = { ctrlKey: true }) => {
  const event = new KeyboardEvent("keydown", {
    key: "b",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

let sync: DocumentSync | undefined;
afterEach(() => {
  cleanup();
  sync?.destroy();
  sync = undefined;
});
beforeAll(() => {
  Range.prototype.getClientRects = () => document.createElement("div").getClientRects();
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe("sidebar keyboard shortcut", () => {
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "toggles outside editors with %j",
    (modifiers) => {
      render(
        <SidebarProvider>
          <State />
          <button>Outside</button>
        </SidebarProvider>,
      );
      expect(
        shortcut(screen.getByRole("button", { name: "Outside" }), modifiers).defaultPrevented,
      ).toBe(true);
      expect(screen.getByLabelText("Sidebar state")).toHaveTextContent("collapsed");
    },
  );

  it.each([
    {},
    { ctrlKey: true, altKey: true },
    { metaKey: true, shiftKey: true },
    { ctrlKey: true, metaKey: true },
  ])("ignores unsupported modifiers %j", (modifiers) => {
    render(
      <SidebarProvider>
        <State />
        <button>Outside</button>
      </SidebarProvider>,
    );
    expect(shortcut(screen.getByRole("button"), modifiers).defaultPrevented).toBe(false);
    expect(screen.getByLabelText("Sidebar state")).toHaveTextContent("expanded");
  });

  it("leaves an already consumed shortcut to its owner", () => {
    render(
      <SidebarProvider>
        <State />
        <button onKeyDown={(event) => event.preventDefault()}>Owner</button>
      </SidebarProvider>,
    );
    expect(shortcut(screen.getByRole("button")).defaultPrevented).toBe(true);
    expect(screen.getByLabelText("Sidebar state")).toHaveTextContent("expanded");
  });

  it("leaves input, textarea, select and contenteditable descendants alone", () => {
    render(
      <SidebarProvider>
        <State />
        <input aria-label="Input" />
        <textarea aria-label="Textarea" />
        <select aria-label="Select">
          <option>One</option>
        </select>
        <div contentEditable suppressContentEditableWarning>
          <span>Editable descendant</span>
        </div>
      </SidebarProvider>,
    );
    for (const target of [
      screen.getByLabelText("Input"),
      screen.getByLabelText("Textarea"),
      screen.getByLabelText("Select"),
      screen.getByText("Editable descendant"),
    ]) {
      expect(shortcut(target).defaultPrevented).toBe(false);
    }
    expect(screen.getByLabelText("Sidebar state")).toHaveTextContent("expanded");
  });

  it("lets the real document editor consume Bold without toggling the sidebar", async () => {
    await freshDocumentDevice();
    const server = fakeDocumentServer();
    server.seed({
      id: "sidebar-document",
      conversationId: "chat",
      projectId: null,
      title: "Plan",
      content: "Ship it today",
      revision: 0,
      lastEditedBy: "model",
      canEdit: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    sync = new DocumentSync({
      documentId: "sidebar-document",
      push: (data) => server.push({ data }),
      connect: (url) => new server.EventSource(url),
      extensions: browserEditorExtensions,
      editorProps: browserEditorProps,
      outbox,
      user: { name: "Test", color: "blue", colorLight: "lightblue" },
    });
    await waitFor(() => expect(sync?.editor).not.toBeNull());
    const toolbar = document.createElement("div");
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <SidebarProvider>
          <State />
          <DocumentEditor
            documentId="sidebar-document"
            sync={{ editor: sync.editor! }}
            readOnly={false}
            toolbarSlot={toolbar}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );
    view.container.appendChild(toolbar);
    const surface = await screen.findByRole("textbox", { name: "Document" });
    act(() => {
      sync!.editor!.commands.setTextSelection({ from: 1, to: 8 });
    });
    const event = new KeyboardEvent("keydown", {
      key: "b",
      code: "KeyB",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(surface, event);
    expect(event.defaultPrevented).toBe(true);
    expect(toMarkdown(sync.editor!.state.doc)).toBe("**Ship it** today");
    expect(screen.getByLabelText("Sidebar state")).toHaveTextContent("expanded");
  });
});
