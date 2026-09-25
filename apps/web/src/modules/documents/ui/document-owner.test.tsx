import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDocumentServer } from "../../../../tests/fixtures/document-server.tsx";
import type { EditableDocument } from "../schema.ts";
import { getDocument, pushDocument } from "../server/document-functions.ts";
import { DocumentOwner, type DocumentOwnerHandle } from "./document-owner.tsx";
import { DocumentWidget } from "~/modules/chat/ui/document-activity-block.tsx";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  type DetailPanelApi,
} from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion";

const blocker = vi.hoisted(() => ({
  current: null as null | {
    shouldBlockFn: () => Promise<boolean>;
    enableBeforeUnload: () => boolean;
  },
}));
vi.mock("../server/document-functions.ts", () => ({
  getDocument: vi.fn(),
  pushDocument: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("./rich-editor/document-editor.tsx", async () => ({
  default: (await import("../../../../tests/fixtures/document-server.tsx")).FakeSourceEditor,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/chat/conversation",
  useBlocker: (options: typeof blocker.current) => {
    blocker.current = options;
  },
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => false }));

let server: ReturnType<typeof fakeDocumentServer>;
let panel: DetailPanelApi;
const fresh = (): EditableDocument => ({
  id: "document-1",
  conversationId: "conversation",
  createdByMessageId: "m-answer",
  title: "Notes",
  content: "Original",
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
const fixture = async (onGone = vi.fn()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ref = createRef<DocumentOwnerHandle>();
  render(
    <QueryClientProvider client={client}>
      <AppMotionProvider>
        <ConfirmProvider>
          <DetailPanelProvider>
            <DocumentOwner documentIds={["document-1"]} onGone={onGone} ref={ref}>
              <DocumentWidget documentId="document-1" title="Notes" />
            </DocumentOwner>
            <Probe />
            <DetailPanelRail />
          </DetailPanelProvider>
        </ConfirmProvider>
      </AppMotionProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open document: Notes" }));
  return { client, ref, onGone };
};

beforeEach(() => {
  vi.clearAllMocks();
  server = fakeDocumentServer();
  server.seed(fresh());
  vi.stubGlobal("EventSource", server.EventSource);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.mocked(getDocument).mockImplementation(async ({ data }) => server.row(data.documentId));
  vi.mocked(pushDocument).mockImplementation(server.push);
});

describe("conversation-owned document", () => {
  it("keeps typing made just before the panel closes, and reopens on the stored text", async () => {
    await fixture();
    const source = await screen.findByRole("textbox", { name: "Document source" });
    const release = server.holdPushes();
    fireEvent.change(source, { target: { value: "Persistent local source" } });
    act(() => panel.open({ id: "sources", title: "Sources", body: <p>Source detail</p> }));
    expect(screen.getByText("Source detail")).toBeVisible();
    // The closed editor's connection stays until its last batch is stored.
    await act(async () => release());
    await waitFor(() => expect(server.content("document-1")).toBe("Persistent local source"));

    fireEvent.click(screen.getByRole("button", { name: "Open document: Notes" }));
    expect(await screen.findByRole("textbox", { name: "Document source" })).toHaveValue(
      "Persistent local source",
    );
  });

  it("flushes before dependent actions and holds navigation until typing is stored", async () => {
    const { ref } = await fixture();
    const source = await screen.findByRole("textbox", { name: "Document source" });
    const release = server.holdPushes();
    fireEvent.change(source, { target: { value: "Saved before send" } });
    await waitFor(() => expect(blocker.current!.enableBeforeUnload()).toBe(true));
    let flushed: Promise<boolean> | undefined;
    act(() => {
      flushed = ref.current!.flush();
    });
    await act(async () => release());
    await act(async () => {
      expect(await flushed).toBe(true);
    });
    expect(server.content("document-1")).toBe("Saved before send");
    expect(blocker.current!.enableBeforeUnload()).toBe(false);
    await act(async () => {
      expect(await blocker.current!.shouldBlockFn()).toBe(false);
    });
  });

  it("forgets a document the conversation rewound away", async () => {
    const onGone = vi.fn();
    await fixture(onGone);
    await screen.findByRole("textbox", { name: "Document source" });
    act(() => server.remove("document-1"));

    await waitFor(() => expect(onGone).toHaveBeenCalledWith("document-1"));
  });
});
