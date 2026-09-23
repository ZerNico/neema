import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDocument } from "../schema.ts";
import { toggleTaskItem } from "../task-items.ts";
import { getDocument, saveDocument, toggleDocumentTask } from "../server/document-functions.ts";
import { DocumentOwner } from "./document-owner.tsx";
import { DocumentWidget } from "~/modules/chat/ui/document-activity-block.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  type DetailPanelApi,
} from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion";

vi.mock("../server/document-functions.ts", () => ({
  getDocument: vi.fn(),
  saveDocument: vi.fn(),
  toggleDocumentTask: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("~/modules/skills/ui/text-editor.tsx", () => ({
  default: ({
    value,
    onChange,
    label,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      readOnly={readOnly ?? false}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/chat/conversation",
  useBlocker: vi.fn(),
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => false }));

let server: ConversationDocument | null;
let panel: DetailPanelApi;
const fresh = (): ConversationDocument => ({
  id: "document-1",
  conversationId: "conversation",
  createdByMessageId: "m-answer",
  title: "Checklist",
  content: "- [ ] first\n  - [x] nested\n\n1. [ ] numbered",
  revision: 1,
  lastEditedBy: "model",
  createdAt: "2026-09-15T10:00:00Z",
  updatedAt: "2026-09-15T10:00:00Z",
});
function Probe() {
  const api = useDetailPanel();
  useEffect(() => {
    panel = api;
  }, [api]);
  return null;
}
const fixture = async (locked = false) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <DocumentOwner documentIds={["document-1"]} locked={locked} onGone={vi.fn()}>
              <DocumentWidget documentId="document-1" title="Checklist" />
            </DocumentOwner>
            <Probe />
            <DetailPanelRail />
          </DetailPanelProvider>
        </ConfirmProvider>
      </AppMotionProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open document: Checklist" }));
  return { client };
};

beforeEach(() => {
  vi.clearAllMocks();
  server = fresh();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.mocked(getDocument).mockImplementation(async () => server);
  vi.mocked(saveDocument).mockImplementation(async ({ data }) => {
    if (data.expectedRevision !== server!.revision)
      return { outcome: "conflict" as const, document: server! };
    if (data.content === server!.content)
      return { outcome: "unchanged" as const, document: server! };
    server = {
      ...server!,
      content: data.content,
      revision: server!.revision + 1,
      lastEditedBy: "user",
    };
    return { outcome: "updated" as const, document: server };
  });
  // The ordinal patch takes no revision precondition: it rewrites one line of
  // whatever the server currently holds.
  vi.mocked(toggleDocumentTask).mockImplementation(async ({ data }) => {
    const content = toggleTaskItem(server!.content, data.ordinal, data.checked);
    if (content === null) return { outcome: "no_match" as const, document: server! };
    if (content === server!.content) return { outcome: "unchanged" as const, document: server! };
    server = { ...server!, content, revision: server!.revision + 1, lastEditedBy: "user" };
    return { outcome: "updated" as const, document: server };
  });
});

describe("document panel", () => {
  it("enables rendered GFM tasks and sends the source ordinal for nested and numbered items", async () => {
    await fixture();
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.getAttribute("aria-disabled") !== "true")).toBe(true);

    fireEvent.click(boxes[1]!);

    await waitFor(() =>
      expect(toggleDocumentTask).toHaveBeenCalledWith({
        data: { documentId: "document-1", ordinal: 1, checked: false },
      }),
    );
    expect(server!.content).toContain("  - [ ] nested");
  });

  it("keeps loose GFM task items interactive", async () => {
    server = { ...server!, content: "- [ ] first\n\n  continued\n\n- [ ] second" };
    await fixture();
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.getAttribute("aria-disabled") !== "true")).toBe(true);
  });

  it("holds a tick through a competing revision instead of refusing it", async () => {
    const { client } = await fixture();
    const box = (await screen.findAllByRole("checkbox"))[0]!;
    // The assistant edits a different line while the click is being handled.
    server = {
      ...server!,
      content: `# Heading\n${server!.content}`,
      revision: server!.revision + 1,
    };
    act(() => client.setQueryData(["documents", "document-1"], server));

    fireEvent.click(box);

    await waitFor(() => expect(toggleDocumentTask).toHaveBeenCalled());
    expect(
      screen.queryByText("The document changed before that task could be updated. Try again."),
    ).not.toBeInTheDocument();
    expect(server!.content).toContain("- [x] first");
    expect(server!.content).toContain("# Heading");
  });

  it("locks tasks and source while the assistant is answering", async () => {
    await fixture(true);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.every((box) => box.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getByText("Read-only while the assistant is answering.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByRole("textbox", { name: "Document source" })).toHaveAttribute(
      "readonly",
    );
    expect(toggleDocumentTask).not.toHaveBeenCalled();
  });

  it("autosaves source and offers an explicit choice for a competing edit", async () => {
    const { client } = await fixture();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const source = await screen.findByRole("textbox", { name: "Document source" });
    fireEvent.change(source, { target: { value: "My local draft" } });
    await waitFor(() => expect(saveDocument).toHaveBeenCalled(), { timeout: 2_000 });
    expect(server!.content).toBe("My local draft");

    fireEvent.change(source, { target: { value: "More local work" } });
    server = { ...server!, content: "Assistant edit", revision: server!.revision + 1 };
    act(() => client.setQueryData(["documents", "document-1"], server));
    expect(await screen.findByRole("region", { name: "Document conflict" })).toBeVisible();
    expect(source).toHaveValue("More local work");

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(server!.content).toBe("More local work"));
    expect(screen.queryByRole("region", { name: "Document conflict" })).not.toBeInTheDocument();
  });

  it("keeps the newest keystrokes when an unrelated render replays the panel snapshot", async () => {
    await fixture();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const source = await screen.findByRole("textbox", { name: "Document source" });
    fireEvent.change(source, { target: { value: "first" } });
    await waitFor(() => expect(saveDocument).toHaveBeenCalled(), { timeout: 2_000 });
    // A re-render with no new document state must not push the stored snapshot
    // back into the editor over text it has not seen.
    fireEvent.change(source, { target: { value: "first and more" } });
    act(() => panel.refresh({ id: "document:document-1", title: "x", body: null }));
    expect(source).toHaveValue("first and more");
  });

  it("copies the current source and offers no rename, delete or download", async () => {
    await fixture();
    fireEvent.click(screen.getByRole("button", { name: "Copy document" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(server!.content),
    );
    expect(screen.queryByRole("textbox", { name: "Document title" })).not.toBeInTheDocument();
    for (const name of [/Rename document/, /Delete document/, /Download document/])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();

    act(() => panel.close());
  });
});
