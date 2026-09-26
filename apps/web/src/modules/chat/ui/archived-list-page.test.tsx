import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setConversationArchived } from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ArchivedChatsListPage } from "./archived-list-page.tsx";

vi.mock("../server/functions.ts", () => ({
  setConversationArchived: vi.fn(),
  listArchivedConversations: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
  getConversationWithMessages: vi.fn(),
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("~/modules/projects/server/functions.ts", () => ({ moveConversationToProject: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: unknown; to?: string }) => (
    <a href={to}>{children as never}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const renderPage = (rows: ReadonlyArray<{ id: string; title: string | null }>) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    ["conversations", "archived"],
    rows.map((row) => ({ ...row, archivedAt: "2026-09-20T10:00:00Z" })),
  );
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ArchivedChatsListPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.mocked(setConversationArchived).mockReset().mockResolvedValue(undefined);
});

describe("ArchivedChatsListPage", () => {
  it("lists archived chats under a way back to Chats, and unarchives one", async () => {
    const user = userEvent.setup();
    renderPage([
      { id: "c1", title: "Lisbon trip" },
      { id: "c2", title: "Tax return" },
    ]);
    expect(screen.getByRole("link", { name: /Chats/ })).toHaveAttribute("href", "/chats");
    expect(screen.getByRole("link", { name: /Lisbon trip/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for Lisbon trip" }));
    await user.click(await screen.findByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() =>
      expect(setConversationArchived).toHaveBeenCalledWith({
        data: { conversationId: "c1", archived: false },
      }),
    );
  });

  it("filters by title and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderPage([{ id: "c1", title: "Lisbon trip" }]);
    await user.type(screen.getByRole("searchbox", { name: "Search archived chats" }), "zzz");
    expect(await screen.findByText("No archived chats match")).toBeInTheDocument();
  });

  it("says so when nothing is archived", () => {
    renderPage([]);
    expect(screen.getByText("No archived chats")).toBeInTheDocument();
  });
});
