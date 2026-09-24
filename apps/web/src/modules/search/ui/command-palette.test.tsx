import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { listConversations, searchChats } from "~/modules/chat/server/functions.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { ALL_CAPABILITIES, type Capabilities } from "~/modules/groups/policy.ts";
import { SidebarProvider } from "~/ui/primitives/sidebar";
import { CommandPaletteProvider, SearchButton } from "./command-palette.tsx";

vi.mock("~/modules/chat/server/functions.ts", () => ({
  listConversations: vi.fn(),
  searchChats: vi.fn(),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({ listAgents: vi.fn() }));
vi.mock("~/modules/knowledge/server/functions.ts", () => ({
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/skills/server/functions.ts", () => ({
  listSkills: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/schedules/server/functions.ts", () => ({
  listSchedules: vi.fn().mockResolvedValue([]),
}));
vi.mock("~/modules/auth/server/functions.ts", () => ({
  getSessionUser: vi.fn(),
  getSessionIdentity: vi.fn(),
}));
vi.mock("~/modules/groups/server/functions.ts", () => ({ getMyCapabilities: vi.fn() }));

const agent = {
  id: "a1",
  name: "Research agent",
  description: "Digs through sources",
  icon: "robot",
  audience: "private" as const,
  configRevision: 1,
  canEdit: true,
  ownerName: null,
};

async function renderPalette(
  options: { capabilities?: Capabilities; role?: "user" | "admin" } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(capabilitiesQuery.queryKey, options.capabilities ?? ALL_CAPABILITIES);
  queryClient.setQueryData(sessionUserQuery.queryKey, {
    id: "u1",
    name: "Ada",
    role: options.role ?? "user",
  } as never);
  queryClient.setQueryData(agentsQuery.queryKey, [agent] as never);
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <CommandPaletteProvider>
          <SearchButton />
          <Outlet />
        </CommandPaletteProvider>
      </SidebarProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>page {path}</p> });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/"),
      page("/chat/$conversationId"),
      page("/agents/$agentId"),
      page("/admin/users"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const palette = () => screen.getByRole("dialog", { name: "Search" });
const input = () => within(palette()).getByRole("combobox", { name: "Search" });
const openWithShortcut = () => fireEvent.keyDown(window, { key: "k", metaKey: true });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.mocked(searchChats).mockResolvedValue([]);
  vi.mocked(listConversations).mockResolvedValue({
    conversations: [{ id: "c1", title: "Koffergrößen Ryanair" }],
    nextCursor: null,
  } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("command palette", () => {
  it("opens from the header button and from Cmd+K, and toggles closed again", async () => {
    await renderPalette();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(palette()).toBeVisible();
    act(() => void openWithShortcut());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    act(() => void openWithShortcut());
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeVisible();
  });

  it("shows recent chats and actions before anything is typed, but no pages", async () => {
    await renderPalette();
    openWithShortcut();
    expect(await within(palette()).findByText("Koffergrößen Ryanair")).toBeVisible();
    expect(within(palette()).getByText("Recent chats")).toBeVisible();
    expect(within(palette()).getByText("New chat")).toBeVisible();
    expect(within(palette()).queryByText("Pages")).toBeNull();
  });

  it("narrows to actions with > and runs the chosen one", async () => {
    const user = userEvent.setup();
    await renderPalette();
    openWithShortcut();
    await user.type(input(), ">dark");
    expect(within(palette()).getByText("Use dark theme")).toBeVisible();
    expect(within(palette()).queryByText("Recent chats")).toBeNull();
    expect(within(palette()).queryByText("Research agent")).toBeNull();
    await user.keyboard("{Enter}");

    expect(document.documentElement).toHaveClass("dark");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
  });

  it("filters agents locally and opens the chosen one", async () => {
    const user = userEvent.setup();
    const router = await renderPalette();
    openWithShortcut();
    await user.type(input(), "digs");
    const option = await within(palette()).findByRole("option", { name: /Research agent/ });
    expect(option).toHaveTextContent("Digs through sources");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents/a1"));
  });

  it("leaves out agents the account may not use", async () => {
    const user = userEvent.setup();
    await renderPalette({ capabilities: { ...ALL_CAPABILITIES, agentsUse: false } });
    openWithShortcut();
    await user.type(input(), "research");
    expect(within(palette()).queryByText("Research agent")).toBeNull();
    expect(within(palette()).queryByText("New agent")).toBeNull();
  });

  it("searches chat text on the server and highlights the match", async () => {
    const user = userEvent.setup();
    vi.mocked(searchChats).mockResolvedValue([
      {
        conversationId: "c9",
        title: "Packing list",
        messageId: "m1",
        snippet: { text: "Das Handgepäck darf 10 kg wiegen", highlights: [[4, 14]] },
      },
    ]);
    const router = await renderPalette();
    openWithShortcut();
    await user.type(input(), "handgep");

    const option = await within(palette()).findByRole("option", { name: /Packing list/ });
    expect(vi.mocked(searchChats)).toHaveBeenLastCalledWith({ data: { query: "handgep" } });
    expect(within(option).getByText("Handgepäck").tagName).toBe("MARK");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat/c9"));
  });

  it("does not ask the server about a single character", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await renderPalette();
      openWithShortcut();
      await user.type(input(), "h");
      // Well past the typing pause the chat source waits for.
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(within(palette()).getByText("Use light theme")).toBeVisible();
      expect(vi.mocked(searchChats)).not.toHaveBeenCalled();

      await user.type(input(), "a");
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(vi.mocked(searchChats).mock.calls.map(([call]) => call.data.query)).toEqual(["ha"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps admin pages from other accounts", async () => {
    const user = userEvent.setup();
    await renderPalette();
    openWithShortcut();
    await user.type(input(), "users");
    expect(await within(palette()).findByText("Nothing found")).toBeVisible();
  });

  it("offers admin pages to admins, labelled as such", async () => {
    const user = userEvent.setup();
    const router = await renderPalette({ role: "admin" });
    openWithShortcut();
    await user.type(input(), "users");
    const option = await within(palette()).findByRole("option", { name: /Users/ });
    expect(option).toHaveTextContent("Admin");
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
  });
});
