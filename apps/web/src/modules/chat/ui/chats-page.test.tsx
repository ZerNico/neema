import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatsPage } from "./chats-page.tsx";
import { listConversations } from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";

vi.mock("../server/functions.ts", () => ({
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
}));

// The page only needs Link to render something clickable and the param lookup
// to say "no active conversation"; a real router is far more machinery.
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
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const listMock = vi.mocked(listConversations);

const BASE = new Date("2026-03-01T12:00:00Z").getTime();

const conversation = (id: string, title: string | null, minutesAgo: number) => ({
  id,
  userId: "u1",
  title,
  modelId: "m1",
  branchedFrom: null as string | null,
  generating: false,
  createdAt: new Date(BASE - minutesAgo * 60_000),
  updatedAt: new Date(BASE - minutesAgo * 60_000),
  lastMessageAt: new Date(BASE - minutesAgo * 60_000),
});

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <ChatsPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.setSystemTime(BASE);
});

describe("ChatsPage", () => {
  it("scrolls through the shared Page container, heading and list included", async () => {
    listMock.mockResolvedValue({
      conversations: [conversation("a", "A chat", 5)],
      nextCursor: null,
    } as never);
    const { container } = renderPage();

    const chat = await screen.findByRole("link", { name: /A chat/ });
    const scroller = container.firstElementChild;
    expect(scroller).toHaveClass("h-full", "overflow-y-auto");
    expect(scroller).toContainElement(screen.getByRole("heading", { name: "Chats" }));
    expect(scroller).toContainElement(screen.getByRole("searchbox", { name: "Search chats" }));
    expect(scroller).toContainElement(chat);
  });

  it("renders conversations grouped by recency", async () => {
    listMock.mockResolvedValue({
      // Four days back lands in the same bucket regardless of the runner's
      // timezone, which shifts the calendar-day boundary by up to a day.
      conversations: [
        conversation("a", "Today's chat", 5),
        conversation("b", "Old chat", 60 * 24 * 4),
      ],
      nextCursor: null,
    } as never);

    renderPage();

    expect(await screen.findByText("Today's chat")).toBeInTheDocument();
    expect(screen.getByText("Old chat")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Previous 7 days" })).toBeInTheDocument();
  });

  it("sends the debounced search text to the server", async () => {
    listMock.mockResolvedValue({
      conversations: [conversation("a", "Drizzle", 5)],
      nextCursor: null,
    } as never);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(BASE);

    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "driz" } });
    // Still debouncing: no second request for a half-typed word.
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock.mock.calls[1]?.[0]).toMatchObject({ data: { query: "driz" } });
  });

  it("bounds title search to the server’s 200-character limit", async () => {
    listMock.mockResolvedValue({ conversations: [], nextCursor: null } as never);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(BASE);
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    const field = screen.getByLabelText("Search chats");
    expect(field).toHaveAttribute("maxLength", "200");
    fireEvent.change(field, { target: { value: "X".repeat(201) } });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(listMock.mock.calls[1]?.[0]).toMatchObject({ data: { query: "X".repeat(200) } });
  });

  it("appends the next page and drops the button at the end", async () => {
    listMock
      .mockResolvedValueOnce({
        conversations: [conversation("a", "First page", 5)],
        nextCursor: { activity: new Date(BASE - 300_000).toISOString(), id: "a" },
      } as never)
      .mockResolvedValueOnce({
        conversations: [conversation("b", "Second page", 10)],
        nextCursor: null,
      } as never);

    renderPage();

    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);

    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(screen.getByText("First page")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument(),
    );
    // Page two asked for exactly the cursor page one handed back.
    expect(listMock.mock.calls[1]?.[0]).toMatchObject({ data: { cursor: { id: "a" } } });
  });

  it("distinguishes an empty account from an empty search", async () => {
    listMock.mockResolvedValue({ conversations: [], nextCursor: null } as never);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(BASE);

    renderPage();

    expect(await screen.findByText("No chats yet")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "nope" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByText("No chats match")).toBeInTheDocument();
    expect(screen.queryByText("No chats yet")).not.toBeInTheDocument();
  });

  it("marks the rows that were branched off another chat", async () => {
    listMock.mockResolvedValue({
      conversations: [
        { ...conversation("a", "Forked chat", 5), branchedFrom: "root" },
        conversation("b", "Root chat", 10),
      ],
      nextCursor: null,
    } as never);

    renderPage();

    const forked = (await screen.findByText("Forked chat")).closest("a")!;
    expect(within(forked).getByLabelText("Branched conversation")).toBeInTheDocument();
    const root = screen.getByText("Root chat").closest("a")!;
    expect(within(root).queryByLabelText("Branched conversation")).toBeNull();
  });

  it("spins on the rows still writing an answer", async () => {
    listMock.mockResolvedValue({
      conversations: [
        { ...conversation("a", "Busy chat", 5), generating: true },
        conversation("b", "Settled chat", 10),
      ],
      nextCursor: null,
    } as never);

    renderPage();

    const busy = (await screen.findByText("Busy chat")).closest("a")!;
    expect(within(busy).getByLabelText("Generating")).toBeInTheDocument();
    const settled = screen.getByText("Settled chat").closest("a")!;
    expect(within(settled).queryByLabelText("Generating")).toBeNull();
  });

  it("lets the spinner displace the branch icon until the answer lands", async () => {
    listMock.mockResolvedValue({
      conversations: [
        { ...conversation("a", "Busy fork", 5), branchedFrom: "root", generating: true },
      ],
      nextCursor: null,
    } as never);

    renderPage();

    const row = (await screen.findByText("Busy fork")).closest("a")!;
    expect(within(row).getByLabelText("Generating")).toBeInTheDocument();
    expect(within(row).queryByLabelText("Branched conversation")).toBeNull();
  });

  it("offers rename and delete per row", async () => {
    listMock.mockResolvedValue({
      conversations: [conversation("a", "Renameable", 5)],
      nextCursor: null,
    } as never);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Renameable" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Rename")).toBeInTheDocument();
    expect(within(menu).getByText("Delete")).toBeInTheDocument();
  });
});
