import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDocument } from "../schema.ts";
import { getDocument, saveDocument, toggleDocumentTask } from "../server/document-functions.ts";
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
  saveDocument: vi.fn(),
  toggleDocumentTask: vi.fn(),
  listDocuments: vi.fn(),
}));
vi.mock("~/modules/skills/ui/text-editor.tsx", () => ({
  default: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/chat/conversation",
  useBlocker: (options: typeof blocker.current) => {
    blocker.current = options;
  },
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => false }));

let server: ConversationDocument | null;
let panel: DetailPanelApi;
const fresh = (): ConversationDocument => ({
  id: "document-1",
  conversationId: "conversation",
  createdByMessageId: "m-answer",
  title: "Notes",
  content: "Original",
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
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  return { client, ref, onGone };
};

beforeEach(() => {
  vi.clearAllMocks();
  server = fresh();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.mocked(getDocument).mockImplementation(async () => server);
  vi.mocked(saveDocument).mockImplementation(async ({ data }) => {
    if (data.expectedRevision !== server!.revision)
      return { outcome: "conflict" as const, document: server! };
    server = {
      ...server!,
      content: data.content,
      revision: server!.revision + 1,
      lastEditedBy: "user",
    };
    return { outcome: "updated" as const, document: server };
  });
  vi.mocked(toggleDocumentTask).mockRejectedValue(new Error("not used"));
});

describe("conversation-owned document", () => {
  it("retains source when the panel closes or another detail replaces it", async () => {
    await fixture();
    const source = await screen.findByRole("textbox", { name: "Document source" });
    fireEvent.change(source, { target: { value: "Persistent local source" } });
    act(() => panel.open({ id: "sources", title: "Sources", body: <p>Source detail</p> }));
    expect(screen.getByText("Source detail")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Open document: Notes" }));
    expect(await screen.findByRole("textbox", { name: "Document source" })).toHaveValue(
      "Persistent local source",
    );
  });

  it("flushes before dependent actions and blocks on an unresolved remote edit", async () => {
    const { client, ref } = await fixture();
    const source = await screen.findByRole("textbox", { name: "Document source" });
    fireEvent.change(source, { target: { value: "Saved before send" } });
    await act(async () => {
      expect(await ref.current!.flush()).toBe(true);
    });
    expect(server!.content).toBe("Saved before send");

    fireEvent.change(source, { target: { value: "Local conflict" } });
    server = { ...server!, content: "Remote conflict", revision: server!.revision + 1 };
    act(() => client.setQueryData(["documents", "document-1"], server));
    await act(async () => {
      expect(await ref.current!.flush()).toBe(false);
    });
    expect(source).toHaveValue("Local conflict");
    expect(blocker.current!.enableBeforeUnload()).toBe(true);
    await act(async () => {
      expect(await blocker.current!.shouldBlockFn()).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Document conflict" })).toBeVisible(),
    );
  });

  it("forgets a document the conversation rewound away", async () => {
    const onGone = vi.fn();
    const { client } = await fixture(onGone);
    await screen.findByRole("textbox", { name: "Document source" });
    server = null;
    act(() => client.setQueryData(["documents", "document-1"], null));

    await waitFor(() => expect(onGone).toHaveBeenCalledWith("document-1"));
  });
});
