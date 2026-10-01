import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionPage } from "./collection-page.tsx";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { KnowledgePage } from "./knowledge-page.tsx";
import {
  deleteKnowledgeDocument,
  readKnowledgeDocument,
  retryKnowledgeDocument,
} from "../server/functions.ts";
import type { KnowledgeDocument } from "../schema.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";

vi.mock("../server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn(),
  getKnowledgeCollection: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  updateKnowledgeCollection: vi.fn(),
  deleteKnowledgeCollection: vi.fn(),
  addKnowledgeNote: vi.fn(),
  replaceKnowledgeNote: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  retryKnowledgeDocument: vi.fn(),
  rebuildKnowledgeIndex: vi.fn(),
  uploadKnowledgeDocument: vi.fn(),
  readKnowledgeDocument: vi.fn(),
}));
vi.mock("~/modules/sharing/server/functions.ts", () => ({
  getResourceSharing: vi.fn(),
  shareResourceWithEmail: vi.fn(),
  shareResourceWithGroup: vi.fn(),
  revokeResourceUser: vi.fn(),
  revokeResourceGroup: vi.fn(),
  publishResource: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a
      href={String(to)}
      data-collection-id={(params as { collectionId?: string } | undefined)?.collectionId}
      {...(rest as object)}
    >
      {children as never}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/knowledge/c" }, matches: [] }),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const collection = (overrides: {
  id: string;
  name: string;
  canEdit?: boolean;
  ownerName?: string | null;
  documentCount?: number;
  pendingCount?: number;
  failedCount?: number;
}) => ({
  id: overrides.id,
  name: overrides.name,
  description: "",
  audience: "private" as const,
  canEdit: overrides.canEdit ?? true,
  ownerName: overrides.ownerName ?? null,
  documentCount: overrides.documentCount ?? 2,
  readyCount: 2,
  failedCount: overrides.failedCount ?? 0,
  pendingCount: overrides.pendingCount ?? 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const document = (
  overrides: Partial<KnowledgeDocument> & { id: string; title: string },
): KnowledgeDocument => ({
  collectionId: "c1",
  kind: "file",
  status: "ready",
  semanticStatus: "ready",
  fileName: "source.pdf",
  mediaType: "application/pdf",
  byteSize: 1000,
  charCount: 4200,
  pageCount: 3,
  truncated: false,
  error: null,
  versionId: "v1",
  replacement: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const client = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["capabilities"], ALL_CAPABILITIES);
  return queryClient;
};

const renderDetail = (
  documents: KnowledgeDocument[],
  options: { canEdit?: boolean; ownerName?: string | null } = {},
) => {
  const queryClient = client();
  queryClient.setQueryData(["knowledge", "collection", "c1"], {
    collection: collection({ id: "c1", name: "Contracts", ...options }),
    documents,
  });
  queryClient.setQueryData(["knowledge", "collections"], []);
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AppMotionProvider>
          <DetailPanelProvider>
            <ConfirmProvider>
              <CollectionPage collectionId="c1" />
            </ConfirmProvider>
            <DetailPanelRail />
          </DetailPanelProvider>
        </AppMotionProvider>
      </QueryClientProvider>,
    ),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KnowledgePage", () => {
  it("lists collections with indexing state and separates shared ones", () => {
    const queryClient = client();
    queryClient.setQueryData(
      ["knowledge", "collections"],
      [
        collection({ id: "c1", name: "Contracts", pendingCount: 1 }),
        collection({ id: "c2", name: "Policies", canEdit: false, ownerName: "Dana" }),
      ],
    );
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("1 preparing")).toBeInTheDocument();
    // One action per row: the collection page itself adapts to permissions,
    // so a separate Edit link would lead to the same place.
    expect(screen.getByRole("link", { name: "Open Contracts" })).toHaveAttribute(
      "data-collection-id",
      "c1",
    );
    expect(screen.queryByRole("link", { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Policies" })).toHaveAttribute(
      "data-collection-id",
      "c2",
    );
    expect(screen.getByText(/Shared by Dana/)).toBeInTheDocument();
    expect(screen.getByText("Shared with you")).toBeInTheDocument();
  });
});

describe("CollectionPage", () => {
  it("waits for note initialization and never replaces a draft on refetch", async () => {
    let release!: (value: Awaited<ReturnType<typeof readKnowledgeDocument>>) => void;
    vi.mocked(readKnowledgeDocument).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { queryClient } = renderDetail([document({ id: "d1", title: "Policy", kind: "note" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Policy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Replace note/ }));
    expect(await screen.findByRole("textbox", { name: "Note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace note" })).toBeDisabled();
    await act(async () =>
      release({
        collectionId: "c1",
        documentId: "d1",
        versionId: "v1",
        title: "Policy",
        content: "Original note",
        startOffset: 0,
        endOffset: 13,
        totalChars: 13,
        nextOffset: null,
      }),
    );
    const note = screen.getByRole("textbox", { name: "Note" });
    await waitFor(() => expect(note).toHaveValue("Original note"));
    expect(note).toBeEnabled();
    fireEvent.change(note, { target: { value: "My unsaved draft" } });
    await act(async () => {
      queryClient.setQueryData(["knowledge", "note", "d1", "v1"], "Refetched note");
    });
    expect(note).toHaveValue("My unsaved draft");
  });

  it("shows per-document state and offers retry only for failures", () => {
    renderDetail([
      document({ id: "d1", title: "Signed agreement" }),
      document({
        id: "d2",
        title: "Scanned contract",
        status: "failed",
        versionId: null,
        error: "no readable text could be extracted",
      }),
    ]);
    expect(screen.getByText("no readable text could be extracted")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t prepare document")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Signed agreement" }));
    expect(screen.queryByRole("menuitem", { name: /Retry indexing/ })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Scanned contract" }));
    expect(screen.queryByRole("menuitem", { name: /Retry indexing/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each([
    ["queued", "ready", "Preparing"],
    ["ready", "queued", "Preparing search"],
    ["ready", "failed", "Basic search"],
  ] as const)("explains document state %s / %s", (status, semanticStatus, label) => {
    renderDetail([document({ id: "d1", title: "Policy", status, semanticStatus })]);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText(/4,200 characters/)).not.toBeInTheDocument();
    if (semanticStatus === "failed")
      expect(screen.getByText(/still usable with basic search/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it.each(["queued", "failed"] as const)(
    "keeps the current version available during a %s update",
    async (status) => {
      renderDetail([
        document({
          id: "d1",
          title: "Policy",
          replacement: {
            versionId: "v2",
            title: "New policy",
            status,
            error: status === "failed" ? "Unreadable replacement" : null,
          },
        }),
      ]);
      expect(screen.getByText(status === "failed" ? "Update failed" : "Updating")).toBeVisible();
      expect(screen.getByText("The current version remains available.")).toBeVisible();
      expect(screen.getByRole("link", { name: "Download Policy" })).toBeVisible();
      if (status === "failed") {
        expect(screen.getByText("Unreadable replacement")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
          expect(retryKnowledgeDocument).toHaveBeenCalledWith({ data: { documentId: "d1" } }),
        );
      }
    },
  );

  it("retries a failed document through the server function", async () => {
    renderDetail([
      document({ id: "d2", title: "Scanned", status: "failed", versionId: null, error: "failed" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(vi.mocked(retryKnowledgeDocument)).toHaveBeenCalledWith({
        data: { documentId: "d2" },
      }),
    );
  });

  it("confirms before deleting, warning that citations become unavailable", async () => {
    renderDetail([document({ id: "d1", title: "Signed agreement" })]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Signed agreement" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(
      await screen.findByText(/cited it will show the source as unavailable/i),
    ).toBeInTheDocument();
    expect(vi.mocked(deleteKnowledgeDocument)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await waitFor(() =>
      expect(vi.mocked(deleteKnowledgeDocument)).toHaveBeenCalledWith({
        data: { documentId: "d1" },
      }),
    );
  });

  it("gives a recipient the same view without mutation controls", () => {
    renderDetail([document({ id: "d1", title: "Signed agreement" })], {
      canEdit: false,
      ownerName: "Dana",
    });
    expect(screen.getByText("Signed agreement")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Access" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(screen.getByText(/Shared by Dana/)).toBeInTheDocument();
    // Reading and downloading stay available.
    expect(screen.getByRole("link", { name: "Download Signed agreement" })).toHaveAttribute(
      "href",
      "/api/knowledge/c1/d1/v1",
    );
  });
});
