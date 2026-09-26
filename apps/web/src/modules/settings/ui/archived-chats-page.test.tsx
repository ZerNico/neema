import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveAllConversations } from "~/modules/chat/server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ArchivedChatsPage } from "./archived-chats-page.tsx";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  archiveAllConversations: vi.fn(),
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
  Link: ({ children }: { children?: unknown }) => <a href="/chats">{children as never}</a>,
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
          <ArchivedChatsPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.mocked(archiveAllConversations).mockReset().mockResolvedValue(3);
});

describe("ArchivedChatsPage", () => {
  it("counts archived chats and points to them on the Chats page", () => {
    renderPage([
      { id: "c1", title: "Lisbon trip" },
      { id: "c2", title: null },
    ]);
    expect(screen.getByRole("link", { name: /Archived chats\s?2 chats/ })).toBeInTheDocument();
  });

  it("archives all chats only after confirming", async () => {
    const user = userEvent.setup();
    renderPage([]);
    await user.click(screen.getByRole("button", { name: "Archive all" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(archiveAllConversations).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Archive all" }));
    await waitFor(() => expect(archiveAllConversations).toHaveBeenCalledOnce());
  });
});
