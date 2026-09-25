import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDocument } from "~/modules/knowledge/schema.ts";
import { rebuildKnowledgeIndex } from "~/modules/knowledge/server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { DetailPanelProvider } from "~/ui/detail-panel.tsx";
import type { KnowledgeSourceView } from "../schema.ts";
import { KnowledgeSourcesSection } from "./knowledge-sources-section.tsx";

vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  rebuildKnowledgeIndex: vi.fn(() => Promise.resolve({ reextracted: 0, reembedded: 2 })),
}));
vi.mock("../server/functions.ts", () => ({
  listKnowledgeSources: vi.fn(),
  syncKnowledgeSource: vi.fn(),
  removeKnowledgeSource: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null, useRouterState: () => "/knowledge" }));

const source: KnowledgeSourceView = {
  id: "source-1",
  canEdit: true,
  collectionId: "collection-1",
  integrationId: "outline",
  root: { nodeId: "root", title: "Handbook", mode: "all", rules: [] },
  status: "idle",
  lastError: null,
  lastSyncedAt: null,
  stats: null,
  connected: true,
};

const page = (id: string, semanticStatus: KnowledgeDocument["semanticStatus"]) =>
  ({
    id,
    collectionId: "collection-1",
    title: id,
    kind: "note",
    status: "ready",
    semanticStatus,
    fileName: null,
    mediaType: null,
    byteSize: null,
    charCount: 10,
    pageCount: null,
    truncated: false,
    error: null,
    versionId: `${id}-v1`,
    replacement: null,
    updatedAt: new Date(0).toISOString(),
    source: { sourceId: "source-1", integrationId: "outline", url: null },
  }) as KnowledgeDocument;

const renderSection = (documents: KnowledgeDocument[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["knowledge", "sources", "collection-1"], [source]);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <DetailPanelProvider>
          <KnowledgeSourcesSection
            collectionId="collection-1"
            documents={documents}
            onEdit={() => {}}
          />
        </DetailPanelProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

describe("synced source row", () => {
  it("counts pages whose search could not be prepared, and retries only those", async () => {
    renderSection([
      page("a", "ready"),
      page("b", "failed"),
      page("c", "failed"),
      page("d", "queued"),
    ]);
    expect(screen.getByText(/2 on basic search only/)).toBeInTheDocument();
    expect(screen.getByText(/1 preparing search/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    await waitFor(() =>
      expect(rebuildKnowledgeIndex).toHaveBeenCalledWith({
        data: { collectionId: "collection-1" },
      }),
    );
  });

  it("offers no retry while every page is searchable", () => {
    renderSection([page("a", "ready")]);
    expect(screen.queryByRole("button", { name: "Retry failed" })).not.toBeInTheDocument();
    expect(screen.queryByText(/basic search/)).not.toBeInTheDocument();
  });
});
