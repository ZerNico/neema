import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { DetailPanelProvider, DetailPanelRail } from "~/ui/detail-panel.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { MessageBubble } from "~/modules/chat/ui/message-list.tsx";
import { CitationChip } from "~/modules/chat/ui/citation-chip.tsx";
import { DocumentSourcePanel } from "./document-source-panel.tsx";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../server/functions.ts", () => ({ readKnowledgeDocument: mocks.read }));
vi.mock("~/ui/use-mobile.ts", () => ({ useIsMobile: () => false }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/chat/test" }, matches: [] }),
}));
const source: DocumentSource = {
  kind: "document",
  index: 1,
  title: "Contract",
  snippet: "Copied excerpt",
  read: true,
  collectionId: "c",
  documentId: "d",
  versionId: "v",
  startOffset: 10,
  endOffset: 20,
  page: 2,
  headingPath: "Terms",
};
const response = {
  collectionId: "c",
  documentId: "d",
  versionId: "v",
  title: "Contract",
  content: "Saved text",
  startOffset: 10,
  endOffset: 20,
  totalChars: 100,
  nextOffset: 20,
};
beforeEach(() => {
  mocks.read.mockReset();
  mocks.read.mockResolvedValue(response);
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("document citation viewer", () => {
  it("opens an authenticated saved-version excerpt from a chip without an external link", async () => {
    render(
      <QueryClientProvider client={client()}>
        <AppMotionProvider>
          <DetailPanelProvider>
            <CitationChip source={source} />
            <DetailPanelRail />
          </DetailPanelProvider>
        </AppMotionProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("link", { name: "Source: Contract" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source: Contract" }));
    expect(await screen.findByText("Saved text")).toBeTruthy();
    expect(mocks.read).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      data: { collectionId: "c", documentId: "d", versionId: "v", startOffset: 10, maxChars: 10 },
    });
    // Plain words, no character offsets: the reader learns it is a cited part.
    expect(screen.getByText(/the part of the document the answer cited/)).toBeTruthy();
    expect(screen.queryByText(/Characters \d+/)).toBeNull();
  });

  it("drops old content after access revalidation fails", async () => {
    const queries = client();
    render(
      <QueryClientProvider client={queries}>
        <DocumentSourcePanel source={source} />
      </QueryClientProvider>,
    );
    await screen.findByText("Saved text");
    mocks.read.mockRejectedValue(new Error("Not found"));
    await queries.invalidateQueries({ queryKey: ["knowledge"] });
    expect(await screen.findByText("Source unavailable.")).toBeTruthy();
    expect(screen.queryByText("Saved text")).toBeNull();
  });

  it("rechecks on reopening instead of serving the previously readable body", async () => {
    const queries = client();
    const first = render(
      <QueryClientProvider client={queries}>
        <DocumentSourcePanel source={source} />
      </QueryClientProvider>,
    );
    await screen.findByText("Saved text");
    first.unmount();
    mocks.read.mockRejectedValue(new Error("Not found"));
    render(
      <QueryClientProvider client={queries}>
        <DocumentSourcePanel source={source} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Source unavailable.")).toBeTruthy();
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Saved text")).toBeNull();
  });

  it("walks actual Unicode-safe excerpt starts backwards and resets for another source", async () => {
    mocks.read.mockImplementation(({ data }) =>
      Promise.resolve({
        ...response,
        versionId: data.versionId,
        content: `Excerpt ${data.startOffset}`,
        startOffset: data.startOffset,
        endOffset: Math.min(data.startOffset + 15999, 40000),
        totalChars: 40000,
      }),
    );
    const queries = client();
    const view = render(
      <QueryClientProvider client={queries}>
        <DocumentSourcePanel
          source={{ ...source, startOffset: 0, endOffset: 40000, page: null, headingPath: "" }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Excerpt 0");
    expect(screen.getByText("Document excerpt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next excerpt" }));
    await screen.findByText("Excerpt 15999");
    fireEvent.click(screen.getByRole("button", { name: "Next excerpt" }));
    await screen.findByText("Excerpt 31998");
    fireEvent.click(screen.getByRole("button", { name: "Previous excerpt" }));
    await screen.findByText("Excerpt 15999");
    fireEvent.click(screen.getByRole("button", { name: "Previous excerpt" }));
    await screen.findByText("Excerpt 0");
    expect(screen.queryByRole("button", { name: "Previous excerpt" })).toBeNull();
    view.rerender(
      <QueryClientProvider client={queries}>
        <DocumentSourcePanel
          source={{ ...source, versionId: "other", startOffset: 50, endOffset: 40000 }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Excerpt 50");
    expect(screen.queryByRole("button", { name: "Previous excerpt" })).toBeNull();
  });

  it("bounds large cited ranges and reauthorizes each continuation", async () => {
    mocks.read.mockImplementation(({ data }) =>
      Promise.resolve({
        ...response,
        content: `Excerpt ${data.startOffset}`,
        startOffset: data.startOffset,
        endOffset: data.startOffset + data.maxChars,
        totalChars: 40_000,
      }),
    );
    render(
      <QueryClientProvider client={client()}>
        <DocumentSourcePanel source={{ ...source, endOffset: 20_010 }} />
      </QueryClientProvider>,
    );
    await screen.findByText("Excerpt 10");
    fireEvent.click(screen.getByRole("button", { name: "Next excerpt" }));
    await screen.findByText("Excerpt 16010");
    expect(mocks.read).toHaveBeenLastCalledWith({
      signal: expect.any(AbortSignal),
      data: {
        collectionId: "c",
        documentId: "d",
        versionId: "v",
        startOffset: 16_010,
        maxChars: 4_000,
      },
    });
    expect(screen.queryByRole("button", { name: "Next excerpt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous excerpt" }));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
  });
});

it("renders document citations from an application-authored context activity without callable tools", () => {
  render(
    <QueryClientProvider client={client()}>
      <DetailPanelProvider>
        <MessageBubble
          message={{
            id: "direct-context",
            role: "assistant",
            content: "Contract term[^1].",
            reasoning: "",
            reasoningSeen: false,
            status: "complete",
            toolActivities: [
              {
                family: "knowledge",
                name: "knowledge_context",
                callId: "context",
                status: "complete",
                turnIndex: 0,
                callIndex: 0,
                textOffset: 0,
                summary: {
                  targets: [],
                  documentsListed: 1,
                  passagesReturned: 1,
                  remainingOps: 64,
                  coverage: "All selected documents included.",
                },
                sources: [source],
              },
            ],
          }}
        />
      </DetailPanelProvider>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Source: Contract" })).toBeTruthy();
  // Direct context registers its citation but renders no activity row on the
  // answer: the collection is shown on the question that added it.
  expect(screen.queryByText(/Included in full|Selected documents/)).toBeNull();
  expect(document.querySelector("[data-footnotes]")).toBeNull();
});

it("cancels an unfinished viewer request on close and does not share it with a new opening", async () => {
  const signals: AbortSignal[] = [];
  mocks.read.mockImplementation(({ signal }) => {
    signals.push(signal);
    return new Promise(() => {});
  });
  const queries = client();
  const first = render(
    <QueryClientProvider client={queries}>
      <DocumentSourcePanel source={source} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(signals).toHaveLength(1));
  first.unmount();
  expect(signals[0]!.aborted).toBe(true);
  render(
    <QueryClientProvider client={queries}>
      <DocumentSourcePanel source={source} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[1]!.aborted).toBe(false);
});
