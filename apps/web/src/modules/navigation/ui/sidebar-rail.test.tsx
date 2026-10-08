import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyCapabilities } from "~/modules/groups/server/functions.ts";
import { SidebarProvider, useSidebar } from "~/ui/primitives/sidebar";
import { getSidebarPins, updateSidebarPins } from "../server/functions.ts";
import { SidebarNavRail } from "./sidebar-rail.tsx";

vi.mock("~/modules/groups/server/functions.ts", () => ({ getMyCapabilities: vi.fn() }));
vi.mock("../server/functions.ts", () => ({
  getSidebarPins: vi.fn(),
  updateSidebarPins: vi.fn(),
}));

function SidebarState() {
  const { state } = useSidebar();
  return <output aria-label="Sidebar">{state}</output>;
}

async function renderRail(path = "/") {
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <SidebarNavRail account={<li>Account</li>} />
        <SidebarState />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const page = (to: string) =>
    createRoute({ getParentRoute: () => root, path: to, component: () => <main>{to}</main> });
  const router = createRouter({
    routeTree: root.addChildren(
      ["/", "/projects", "/agents", "/knowledge", "/schedules", "/skills", "/chats"].map(page),
    ),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("main");
  return screen.getByRole("navigation", { name: "Main" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyCapabilities).mockResolvedValue({
    projectsUse: true,
    agentsUse: true,
    knowledgeUse: true,
    schedules: true,
    skillsUse: true,
  } as never);
  vi.mocked(getSidebarPins).mockResolvedValue({ pinned: ["skills", "agents"] });
});

describe("SidebarNavRail", () => {
  it("puts only the pinned pages on the rail, in rail order", async () => {
    const rail = await renderRail();
    await waitFor(() =>
      expect(within(rail).getByRole("link", { name: "Skills" })).toBeInTheDocument(),
    );
    const links = within(rail)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"));
    expect(links).toEqual(["New chat", "Agents", "Skills"]);
  });

  it("pins from the more menu and shows the page on the rail at once", async () => {
    const user = userEvent.setup();
    let resolveSave: (value: { pinned: never[] }) => void = () => {};
    vi.mocked(updateSidebarPins).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve as never;
      }),
    );
    const rail = await renderRail();
    await within(rail).findByRole("link", { name: "Skills" });

    await user.click(within(rail).getByRole("button", { name: "More" }));
    const pinKnowledge = await screen.findByRole("button", { name: "Pin Knowledge" });
    expect(screen.getByRole("button", { name: "Unpin Agents" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(pinKnowledge);

    // Into its place in the rail order, not onto the end.
    expect(updateSidebarPins).toHaveBeenCalledWith({
      data: { pinned: ["agents", "knowledge", "skills"] },
    });
    // Optimistic: on the rail before the save answers.
    expect(within(rail).getByRole("link", { name: "Knowledge" })).toBeInTheDocument();
    await act(async () => resolveSave({ pinned: ["agents", "knowledge", "skills"] as never }));
  });

  it("undoes only the toggle whose save failed, also in the save queued behind it", async () => {
    const user = userEvent.setup();
    let failFirst: (error: Error) => void = () => {};
    vi.mocked(updateSidebarPins)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
      )
      .mockResolvedValueOnce({ pinned: ["skills"] });
    const rail = await renderRail();
    await within(rail).findByRole("link", { name: "Skills" });

    await user.click(within(rail).getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("button", { name: "Pin Knowledge" }));
    await user.click(screen.getByRole("button", { name: "Unpin Agents" }));
    // What the server holds once the second save lands, for the refetch after it.
    vi.mocked(getSidebarPins).mockResolvedValue({ pinned: ["skills"] });
    await act(async () => failFirst(new Error("offline")));

    await waitFor(() => expect(updateSidebarPins).toHaveBeenCalledTimes(2));
    expect(updateSidebarPins).toHaveBeenLastCalledWith({ data: { pinned: ["skills"] } });
    // Both leave through the exit animation.
    await waitFor(() => {
      expect(within(rail).queryByRole("link", { name: "Knowledge" })).not.toBeInTheDocument();
      expect(within(rail).queryByRole("link", { name: "Agents" })).not.toBeInTheDocument();
    });
  });

  it("marks the more button when the page on screen is not on the rail", async () => {
    const rail = await renderRail("/schedules");
    await within(rail).findByRole("link", { name: "Skills" });
    expect(within(rail).getByRole("button", { name: "More" })).toHaveAttribute("data-active");
  });

  it("keeps the rail when the sidebar collapses", async () => {
    const user = userEvent.setup();
    const rail = await renderRail();
    await user.click(within(rail).getByRole("button", { name: "Close sidebar" }));
    expect(screen.getByRole("status", { name: "Sidebar" })).toHaveTextContent("collapsed");
    expect(within(rail).getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "New chat" })).toBeInTheDocument();
  });
});
