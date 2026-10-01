import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocumentServer } from "../../../../tests/fixtures/document-server.tsx";
import type { EditableDocument } from "../schema.ts";
import { getDocument, pushDocument } from "../server/document-functions.ts";
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
  pushDocument: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("./rich-editor/document-editor.tsx", async () => ({
  default: (await import("../../../../tests/fixtures/document-server.tsx")).FakeSourceEditor,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/conversation" }, matches: [] }),
  useBlocker: vi.fn(),
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => false }));

let server: ReturnType<typeof fakeDocumentServer>;
let panel: DetailPanelApi;
const fresh = (): EditableDocument => ({
  id: "document-1",
  conversationId: "conversation",
  createdByMessageId: "m-answer",
  title: "Checklist",
  content: "- [ ] first\n  - [x] nested\n- [ ] third",
  revision: 1,
  lastEditedBy: "model",
  projectId: null,
  canEdit: true,
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
const fixture = async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <DocumentOwner documentIds={["document-1"]} onGone={vi.fn()}>
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
/** The editor mounts once the live document has synced. */
const openSource = () => screen.findByRole("textbox", { name: "Document source" });

beforeEach(() => {
  vi.clearAllMocks();
  server = fakeDocumentServer();
  server.seed(fresh());
  vi.stubGlobal("EventSource", server.EventSource);
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
  vi.mocked(getDocument).mockImplementation(async ({ data }) => server.row(data.documentId));
  vi.mocked(pushDocument).mockImplementation(server.push);
});

describe("document panel", () => {
  it("opens the editor for everyone, and offers the Markdown", async () => {
    await fixture();
    expect(await openSource()).toBeInTheDocument();
    const markdown = screen.getByRole("button", { name: "Show Markdown" });
    expect(markdown).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(markdown);
    expect(markdown).toHaveAttribute("aria-pressed", "true");
    cleanup();
    server.seed({ ...fresh(), canEdit: false });
    await fixture();
    expect(await openSource()).toBeInTheDocument();
    expect(screen.getByText(/^View only · /)).toBeInTheDocument();
  });

  it("tells a project document apart from the chat's own, on the card and in the panel", async () => {
    server.seed({
      ...fresh(),
      conversationId: null,
      createdByMessageId: null,
      projectId: "project-1",
    });
    await fixture();
    expect(await screen.findByText(/^Project document · 1 of 3 tasks done$/)).toBeInTheDocument();
    expect(await screen.findByText(/^Project · Edited/)).toBeInTheDocument();
    cleanup();
    server.seed(fresh());
    await fixture();
    expect(await screen.findByText(/^Document · 1 of 3 tasks done$/)).toBeInTheDocument();
  });

  it("stays editable and shows an assistant edit while the person types", async () => {
    await fixture();
    const source = await openSource();
    expect(source).not.toHaveAttribute("readonly");
    fireEvent.change(source, {
      target: { value: `${server.content("document-1")}\n- [ ] mine` },
    });
    act(() => server.editElsewhere("document-1", (markdown) => `# Assistant\n\n${markdown}`));

    await waitFor(() => expect(server.content("document-1")).toContain("- [ ] mine"));
    expect(server.content("document-1")).toMatch(/^# Assistant\n/);
    expect(source).toHaveValue(server.content("document-1"));
    expect(screen.queryByText(/Read-only/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Document conflict" })).not.toBeInTheDocument();
  });

  it("keeps the newest keystrokes when an unrelated render replays the panel snapshot", async () => {
    await fixture();
    const source = await openSource();
    fireEvent.change(source, { target: { value: "first" } });
    await waitFor(() => expect(server.content("document-1")).toBe("first"));
    fireEvent.change(source, { target: { value: "first and more" } });
    act(() => panel.refresh({ id: "document:document-1", title: "x", body: null }));
    expect(source).toHaveValue("first and more");
  });

  it("copies the current source and offers no rename, delete or download", async () => {
    await fixture();
    await openSource();
    fireEvent.click(screen.getByRole("button", { name: "Copy document" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(server.content("document-1")),
    );
    expect(screen.queryByRole("textbox", { name: "Document title" })).not.toBeInTheDocument();
    for (const name of [/Rename document/, /Delete document/, /Download document/])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();

    act(() => panel.hide());
  });
});
