import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatsPage } from "./chats-page.tsx";
import { deleteConversation, listConversations, restoreConversation } from "../server/functions.ts";

vi.mock("../server/functions.ts", () => ({
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  restoreConversation: vi.fn(),
  renameConversation: vi.fn(),
  setConversationArchived: vi.fn(),
}));

const navigate = vi.fn();
let params: Record<string, string> = {};
let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params: _params,
    children,
    ...rest
  }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
  useMatches: () => [{ pathname: "/chats" }],
  useNavigate: () => navigate,
  useParams: () => params,
  // Live, like the real router's state: read when Undo runs, not at render.
  useRouter: () => ({
    state: {
      get location() {
        return { pathname };
      },
    },
  }),
}));

const listMock = vi.mocked(listConversations);
const deleteMock = vi.mocked(deleteConversation);
const restoreMock = vi.mocked(restoreConversation);

const conversation = (id: string, title: string) => ({
  id,
  userId: "u1",
  title,
  modelId: "m1",
  branchedFrom: null,
  generating: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastMessageAt: new Date(),
});

/** The server's view: what the next list fetch returns. */
let stored: string[] = [];

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatsPage />
      <Toaster />
    </QueryClientProvider>,
  );
};

const remove = async (title: string) => {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${title}` }));
  fireEvent.click(within(await screen.findByRole("menu")).getByText("Delete"));
};

const pressUndo = (target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: "z", metaKey: true, ctrlKey: true });

beforeEach(() => {
  vi.clearAllMocks();
  params = {};
  pathname = "/";
  stored = ["a", "b", "c"];
  const titles: Record<string, string> = { a: "Keep me", b: "Bin me", c: "Bin me too" };
  listMock.mockImplementation(
    async () =>
      ({
        conversations: stored.map((id) => conversation(id, titles[id]!)),
        nextCursor: null,
      }) as never,
  );
  deleteMock.mockImplementation((async ({ data }: { data: { conversationId: string } }) => {
    stored = stored.filter((id) => id !== data.conversationId);
    return `mark-${data.conversationId}`;
  }) as never);
  restoreMock.mockImplementation((async ({ data }: { data: { conversationId: string } }) => {
    stored = [...stored, data.conversationId];
    return true;
  }) as never);
});

// Dismissed while the Toaster is still mounted, so each toast reports its
// close and no pending Undo outlives its test.
afterEach(async () => {
  act(() => void toast.dismiss());
  // Sonner marks a toast removed, and reports it, a frame after the dismiss.
  await waitFor(() =>
    expect(document.querySelector("[data-sonner-toast][data-removed='false']")).toBeNull(),
  );
});

describe("deleting a chat", () => {
  it("removes the row at once, without asking, and offers Undo", async () => {
    renderPage();
    await remove("Bin me");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByText("Bin me")).toBeNull());
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(await screen.findByText("Chat deleted")).toBeInTheDocument();
    expect(deleteMock).toHaveBeenCalledWith({ data: { conversationId: "b" } });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Bin me")).toBeInTheDocument();
    await waitFor(() =>
      expect(restoreMock).toHaveBeenCalledWith({ data: { conversationId: "b", mark: "mark-b" } }),
    );
  });

  it("undoes one delete without bringing back another", async () => {
    renderPage();
    await remove("Bin me");
    await screen.findByText("Chat deleted");
    await remove("Bin me too");
    await waitFor(() => expect(screen.queryByText("Bin me too")).toBeNull());
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));

    // The newest toast is the second delete's; the first one's Undo is older.
    const [firstUndo] = screen.getAllByRole("button", { name: "Undo" }).slice(-1);
    fireEvent.click(firstUndo!);

    expect(await screen.findByText("Bin me")).toBeInTheDocument();
    expect(screen.queryByText("Bin me too")).toBeNull();
    await waitFor(() =>
      expect(restoreMock).toHaveBeenCalledWith({ data: { conversationId: "b", mark: "mark-b" } }),
    );
    expect(screen.queryByText("Bin me too")).toBeNull();
  });

  it("undoes with ⌘Z while the toast is up, but not from a text field", async () => {
    renderPage();
    await remove("Bin me");
    await screen.findByText("Chat deleted");

    pressUndo(screen.getByLabelText("Search chats"));
    // Let any Undo the key started reach the server before asserting none did.
    await act(async () => {});
    expect(restoreMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Bin me")).toBeNull();

    pressUndo();
    expect(await screen.findByText("Bin me")).toBeInTheDocument();
    await waitFor(() => expect(restoreMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Chat deleted")).toBeNull());

    // Spent: a second ⌘Z has nothing left to undo.
    pressUndo();
    await act(async () => {});
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  it("says so when the chat was purged before the Undo", async () => {
    restoreMock.mockResolvedValue(false as never);
    renderPage();
    await remove("Bin me");
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("That chat is already gone")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Bin me")).toBeNull());
  });

  it("puts the row back and withdraws the Undo when the delete fails", async () => {
    deleteMock.mockRejectedValue(new Error("offline"));
    renderPage();
    await remove("Bin me");

    expect(await screen.findByText("Could not delete the chat.")).toBeInTheDocument();
    expect(await screen.findByText("Bin me")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Chat deleted")).toBeNull());
  });

  it("keeps a chat hidden while its delete is on the way, whatever refreshes the list", async () => {
    let land: () => void = () => undefined;
    deleteMock.mockImplementationOnce(
      (({ data }: { data: { conversationId: string } }) =>
        new Promise((resolve) => {
          land = () => {
            stored = stored.filter((id) => id !== data.conversationId);
            resolve(`mark-${data.conversationId}`);
          };
        })) as never,
    );
    renderPage();
    await remove("Bin me");
    await waitFor(() => expect(screen.queryByText("Bin me")).toBeNull());
    // A second delete lands first and refreshes every list, from a server
    // that still has the first chat.
    const fetched = listMock.mock.calls.length;
    await remove("Bin me too");
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(fetched));
    await act(async () => {});
    expect(screen.queryByText("Bin me")).toBeNull();
    expect(screen.queryByText("Bin me too")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    land();
    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(2));
  });

  it("sends a delete after the Undo still on its way, never ahead of it", async () => {
    const order: string[] = [];
    let restore: (value: boolean) => void = () => undefined;
    restoreMock.mockImplementation(
      (({ data }: { data: { conversationId: string } }) =>
        new Promise<boolean>((resolve) => {
          order.push("restore");
          restore = (value) => {
            stored = [...stored, data.conversationId];
            resolve(value);
          };
        })) as never,
    );
    deleteMock.mockImplementation((async ({ data }: { data: { conversationId: string } }) => {
      order.push("delete");
      stored = stored.filter((id) => id !== data.conversationId);
      return `mark-${data.conversationId}`;
    }) as never);
    renderPage();
    await remove("Bin me");
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    // Shown again at once, so it can be deleted again before the Undo lands.
    await screen.findByText("Bin me");
    await waitFor(() => expect(order).toEqual(["delete", "restore"]));
    await remove("Bin me");
    await act(async () => {});
    expect(order).toEqual(["delete", "restore"]);

    restore(true);
    await waitFor(() => expect(order).toEqual(["delete", "restore", "delete"]));
    await waitFor(() => expect(screen.queryByText("Bin me")).toBeNull());
  });

  it("leaves the open chat for home, and Undo reopens it once it is back", async () => {
    params = { conversationId: "b" };
    let restore: (value: boolean) => void = () => undefined;
    restoreMock.mockImplementation(
      () => new Promise<boolean>((resolve) => (restore = resolve)) as never,
    );
    renderPage();
    await remove("Bin me");

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledTimes(1);

    restore(true);
    await waitFor(() =>
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/chat/$conversationId",
        params: { conversationId: "b" },
      }),
    );
  });

  it("leaves the reader where they went since, when Undo comes later", async () => {
    params = { conversationId: "b" };
    renderPage();
    await remove("Bin me");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));

    pathname = "/chat/a";
    const fetched = listMock.mock.calls.length;
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalled());
    // The reopen decision follows the refresh after the restore.
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(fetched));
    await act(async () => {});
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
