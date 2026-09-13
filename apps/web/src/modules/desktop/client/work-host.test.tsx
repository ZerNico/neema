import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { Toaster } from "~/ui/primitives/sonner";
import { DesktopChromeFrame, DesktopChromeProvider, AppHeader } from "~/ui/desktop-chrome.tsx";
import { SidebarProvider, SidebarTrigger } from "~/ui/primitives/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DesktopWorkProvider,
  useWorkApprovals,
  WorkAttention,
  WorkConnectionNotice,
} from "./work-host.tsx";

const PAUSED = /work on this computer is paused/;

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  state: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../server/functions.ts", () => ({
  desktopWorkSnapshot: api.snapshot,
  claimDesktopTool: api.claim,
  submitDesktopToolResult: api.complete,
}));
vi.mock("./bridge.ts", () => ({
  useDesktop: () => client,
  waitForDraftBinding: async () => {},
}));
vi.mock("~/modules/auth/identity-boundary.tsx", () => ({ useIdentityBoundary: () => null }));
const shell = {
  executionSession: () => Effect.succeed({ id: "executor" }),
  cancelCall: (input: unknown) =>
    Effect.sync(() => {
      api.cancel(input);
      return true;
    }),
  setWorkState: (input: unknown) =>
    Effect.sync(() => {
      api.state(input);
    }),
  writeFile: (input: unknown) => Effect.promise(() => api.write(input)),
};
// A browser has no bridge at all, which the provider must survive.
let client: typeof shell | null = shell;
const owner = {
  userId: "user",
  conversationId: "a",
  messageId: "m",
  generationId: "g",
  executorId: "executor",
};
const call = (callId: string) => ({
  ...owner,
  callId,
  name: "write_local_file",
  args: JSON.stringify({ path: "site/file", text: "hello" }),
  claimed: false,
  expiresAt: Date.now() + 60000,
});
const settings = [
  { conversationId: "a", title: "First work", approval: "auto" as const, network: "none" as const },
];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  client = shell;
  render(<DesktopChromeFrame />);
  vi.stubGlobal("__chatDesktop", {
    chrome: {
      platform: "darwin",
      getState: async () => ({ fullscreen: false }),
      onState: () => () => {},
      setTheme: async () => {},
    },
  });
  // jsdom lacks the browser APIs used by the real Toaster.
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.desktopChrome;
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
});

it.each([false, true])(
  "continues through chat/settings navigation without redispatching (lost result: %s)",
  async (loseResult) => {
    let calls = [call("one")];
    api.snapshot.mockImplementation(async () => ({ attempts: [owner], calls, settings }));
    api.claim.mockResolvedValue({ token: "claimed" });
    api.complete.mockImplementation(async ({ data }: { data: { callId: string } }) => {
      calls = calls.filter((c) => c.callId !== data.callId);
      return { accepted: true };
    });
    if (loseResult) api.complete.mockRejectedValueOnce(new Error("Result delivery interrupted"));
    const started = deferred<void>();
    const finished = deferred<{ path: string; bytes: number; created: boolean }>();
    api.write.mockImplementation(() => {
      started.resolve();
      return finished.promise;
    });
    const { queryClient, router } = renderHost("/chat/a");
    await screen.findByRole("button", { name: "Allow one" });
    expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument();
    await act(async () => {
      screen.getByRole("button", { name: "Allow one" }).click();
      await started.promise;
    });
    await act(async () => {
      await router.navigate({ to: "/chat/$conversationId", params: { conversationId: "b" } });
    });
    expect(screen.getByText("Chat b")).toBeTruthy();
    expect(api.cancel).not.toHaveBeenCalled();
    await act(async () => {
      finished.resolve({ path: "site/file", bytes: 5, created: true });
    });
    await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(1));
    if (loseResult) {
      await screen.findByText(PAUSED);
      // The server snapshot is unchanged; only its freshness advances.
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
      });
      // Redelivery is the controller's own one-second backoff, past the default budget.
      await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(2), { timeout: 3000 });
    }
    calls = [call("two")];
    await act(async () => {
      await router.navigate({ to: "/settings" });
      await queryClient.invalidateQueries({ queryKey: ["desktop-work"] });
    });
    expect(await screen.findByRole("button", { name: "Review work approvals (1)" })).toBeTruthy();
    expect(await screen.findByText("Work needs your approval")).toBeTruthy();
    expect(api.write).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("button", { name: "Allow two" })).toBeTruthy();
    expect(api.write).toHaveBeenCalledTimes(1);
  },
);

it("keeps dismissed approvals discoverable without repeating notifications on refresh", async () => {
  let calls = [call("one")];
  api.snapshot.mockImplementation(async () => ({ attempts: [owner], calls, settings }));
  const { queryClient, router } = renderHost("/settings");
  await screen.findByText("Work needs your approval");
  expect(screen.getByText("First work")).toBeInTheDocument();
  const refresh = () => act(() => queryClient.invalidateQueries({ queryKey: ["desktop-work"] }));
  await userEvent.click(screen.getByRole("button", { name: "Close toast" }));
  await waitFor(() =>
    expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument(),
  );
  await refresh();
  expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Review work approvals (1)" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /First work\s?1/ }));
  await screen.findByRole("button", { name: "Allow one" });
  expect(api.claim).not.toHaveBeenCalled();
  await act(() => router.navigate({ to: "/settings" }));
  expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument();

  // A new request deserves attention even while an older one is still pending.
  calls = [calls[0]!, call("two")];
  await refresh();
  await screen.findByText("Work needs your approval");
  expect(screen.getAllByText("Work needs your approval")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Review work approvals (2)" })).toBeInTheDocument();
  calls = [];
  await refresh();
  await waitFor(() =>
    expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument(),
  );
  expect(screen.queryByRole("button", { name: /Review work approvals/ })).not.toBeInTheDocument();
});

it("notifies for separate chats and clears notifications when the host goes away", async () => {
  const otherOwner = { ...owner, conversationId: "b", messageId: "mb", generationId: "gb" };
  api.snapshot.mockResolvedValue({
    attempts: [owner, otherOwner],
    calls: [call("one"), { ...call("two"), ...otherOwner }],
    settings: [...settings, { ...settings[0]!, conversationId: "b", title: "Second work" }],
  });
  const { view } = renderHost("/settings");
  await waitFor(() => expect(screen.getAllByText("Work needs your approval")).toHaveLength(2));
  const secondToast = screen.getByText("Second work").closest("li")!;
  await userEvent.click(within(secondToast).getByRole("button", { name: "Review" }));
  await screen.findByRole("button", { name: "Allow two" });
  await waitFor(() => expect(screen.queryByText("Second work")).not.toBeInTheDocument());
  expect(screen.getByText("First work")).toBeInTheDocument();
  expect(api.claim).not.toHaveBeenCalled();
  view.rerender(<Toaster />);
  await waitFor(() =>
    expect(screen.queryByText("Work needs your approval")).not.toBeInTheDocument(),
  );
  expect(api.cancel).toHaveBeenCalledWith({ callId: "one" });
  expect(api.cancel).toHaveBeenCalledWith({ callId: "two" });
});

it("stays quiet when the last known snapshot held no work", async () => {
  api.snapshot.mockResolvedValueOnce({ attempts: [], calls: [], settings: [] });
  api.snapshot.mockRejectedValue(new Error("Server unreachable"));
  const { queryClient } = renderHost("/settings");
  await waitFor(() => expect(api.snapshot).toHaveBeenCalled());
  await act(() => queryClient.invalidateQueries({ queryKey: ["desktop-work"] }));
  await waitFor(() => expect(api.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByText(PAUSED)).not.toBeInTheDocument();
});

it("says nothing when no snapshot ever arrived", async () => {
  api.snapshot.mockRejectedValue(new Error("Server unreachable"));
  renderHost("/settings");
  await waitFor(() => expect(api.snapshot).toHaveBeenCalled());
  expect(await screen.findByText("Settings")).toBeTruthy();
  expect(screen.queryByText(PAUSED)).not.toBeInTheDocument();
});

it("explains a paused computer and clears it on a successful retry", async () => {
  const working = { attempts: [owner], calls: [], settings };
  api.snapshot.mockResolvedValueOnce(working);
  api.snapshot.mockRejectedValue(new Error("Server unreachable"));
  const { queryClient } = renderHost("/settings");
  await waitFor(() => expect(api.snapshot).toHaveBeenCalled());
  await act(() => queryClient.invalidateQueries({ queryKey: ["desktop-work"] }));
  expect((await screen.findByText(PAUSED)).getAttribute("role")).toBe("status");

  api.snapshot.mockResolvedValue(working);
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByText(PAUSED)).not.toBeInTheDocument());
});

it("renders children unchanged in a browser", async () => {
  client = null;
  vi.stubGlobal("__chatDesktop", undefined);
  api.snapshot.mockRejectedValue(new Error("Server unreachable"));
  renderHost("/chat/a");
  expect(await screen.findByText("Chat a")).toBeTruthy();
  expect(api.snapshot).not.toHaveBeenCalled();
  expect(screen.queryByText(PAUSED)).not.toBeInTheDocument();
});

function Chat() {
  const { conversationId = "" } = useParams({ strict: false });
  const approvals = useWorkApprovals(conversationId);
  return (
    <div>
      Chat {conversationId}
      {[...approvals.pending].map(([id]) => (
        <button key={id} onClick={() => approvals.decide(id, "allow")}>
          Allow {id}
        </button>
      ))}
    </div>
  );
}

function renderHost(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({
    component: () => (
      <DesktopChromeProvider>
        <DesktopWorkProvider userId="user">
          <SidebarProvider>
            <AppHeader>
              <SidebarTrigger />
              <WorkAttention />
            </AppHeader>
            <WorkConnectionNotice />
            <Outlet />
          </SidebarProvider>
        </DesktopWorkProvider>
      </DesktopChromeProvider>
    ),
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/chat/$conversationId",
    component: Chat,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Settings</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat, settingsRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  cleanups.push(() => {
    view.unmount();
    queryClient.clear();
    toast.dismiss();
  });
  return { queryClient, router, view };
}

function deferred<A>() {
  let resolve!: (value: A | PromiseLike<A>) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
