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
import { WORKSPACE_FOLDER_NAME } from "@chat/desktop-rpc";
import { DesktopWorkProvider, WorkAttention, WorkConnectionNotice } from "./work-host.tsx";
import { useWorkApprovals } from "./work-context.ts";

const PAUSED = /work on this computer is paused/;

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  state: vi.fn(),
  write: vi.fn(),
  pendingPromotions: vi.fn(),
  commitPromotion: vi.fn(),
  rollbackPromotion: vi.fn(),
  discardSubmission: vi.fn(),
  reservationStatus: vi.fn(),
  abortReservation: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../server/functions.ts", () => ({
  desktopWorkSnapshot: api.snapshot,
  claimDesktopTool: api.claim,
  submitDesktopToolResult: api.complete,
}));
vi.mock("./bridge.ts", async (importOriginal) => ({
  // The real derivation, so this proves what a queued Work start reports.
  sendFieldsFor: (await importOriginal<typeof import("./bridge.ts")>()).sendFieldsFor,
  useDesktop: () => client,
}));
vi.mock("~/modules/chat/server/functions.ts", () => ({
  abortWorkTurn: api.abortReservation,
  getWorkTurnReservation: api.reservationStatus,
  dispatchQueuedMessage: api.dispatch,
}));
vi.mock("~/modules/auth/identity-context.ts", () => ({ useIdentityBoundary: () => null }));
const shell = {
  executionSession: () => Effect.succeed({ id: "executor" }),
  listPendingPromotions: () => Effect.promise(() => api.pendingPromotions()),
  commitPromotion: (input: unknown) => Effect.promise(() => api.commitPromotion(input)),
  rollbackPromotion: (input: unknown) => Effect.promise(() => api.rollbackPromotion(input)),
  discardSubmission: (input: unknown) => Effect.promise(() => api.discardSubmission(input)),
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
  folderStatus: () =>
    Effect.succeed({
      workspace: { path: "/work/q1" },
      folders: [
        { name: "site", path: "/code/site", alive: true },
        { name: "moved", path: "/code/moved", alive: false },
      ],
      sandbox: { kind: "ready" as const },
    }),
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
const settings = [{ conversationId: "a", title: "First work", approval: "auto" as const }];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  client = shell;
  api.pendingPromotions.mockReset().mockResolvedValue([]);
  api.commitPromotion.mockReset().mockResolvedValue(undefined);
  api.rollbackPromotion.mockReset().mockResolvedValue(undefined);
  api.discardSubmission.mockReset().mockResolvedValue(undefined);
  api.reservationStatus.mockReset();
  api.abortReservation.mockReset().mockResolvedValue(undefined);
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
    api.snapshot.mockImplementation(async () => ({
      attempts: [owner],
      calls,
      settings,
      queued: [],
    }));
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
  api.snapshot.mockImplementation(async () => ({ attempts: [owner], calls, settings, queued: [] }));
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
    queued: [],
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
  api.snapshot.mockResolvedValueOnce({ attempts: [], calls: [], settings: [], queued: [] });
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
  const working = { attempts: [owner], calls: [], settings, queued: [] };
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

it("commits a pending promotion whose turn activated", async () => {
  const pending = {
    conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    reservationId: "550e8400-e29b-41d4-a716-446655440001",
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
  };
  api.pendingPromotions.mockResolvedValue([pending]);
  api.reservationStatus.mockResolvedValue({
    ...pending,
    status: "activated",
    assistantMessageId: "assistant",
  });
  api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [] });

  renderHost("/settings");

  await waitFor(() =>
    expect(api.commitPromotion).toHaveBeenCalledWith({
      conversationId: pending.conversationId,
      reservationId: pending.reservationId,
    }),
  );
  expect(api.abortReservation).not.toHaveBeenCalled();
  expect(api.rollbackPromotion).not.toHaveBeenCalled();
  expect(api.discardSubmission).not.toHaveBeenCalled();
});

it("aborts and rolls back an orphaned reserved promotion", async () => {
  const pending = {
    conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    reservationId: "550e8400-e29b-41d4-a716-446655440001",
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
  };
  api.pendingPromotions.mockResolvedValue([pending]);
  api.reservationStatus.mockResolvedValue({ ...pending, status: "reserved" });
  api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [] });

  renderHost("/settings");

  await waitFor(() =>
    expect(api.discardSubmission).toHaveBeenCalledWith({
      conversationId: pending.conversationId,
      submissionId: pending.submissionId,
    }),
  );
  expect(api.abortReservation).toHaveBeenCalledWith({
    data: { reservationId: pending.reservationId },
  });
  expect(api.rollbackPromotion).toHaveBeenCalledWith({
    conversationId: pending.conversationId,
    reservationId: pending.reservationId,
  });
  expect(api.commitPromotion).not.toHaveBeenCalled();
});

it("retains an orphaned reserved promotion when abort is ambiguous", async () => {
  const pending = {
    conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    reservationId: "550e8400-e29b-41d4-a716-446655440001",
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
  };
  api.pendingPromotions.mockResolvedValue([pending]);
  api.reservationStatus.mockResolvedValue({ ...pending, status: "reserved" });
  api.abortReservation.mockRejectedValue(new Error("Server unreachable"));
  api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [] });

  renderHost("/settings");

  await waitFor(() => expect(api.snapshot).toHaveBeenCalled());
  expect(api.abortReservation).toHaveBeenCalledWith({
    data: { reservationId: pending.reservationId },
  });
  expect(api.commitPromotion).not.toHaveBeenCalled();
  expect(api.rollbackPromotion).not.toHaveBeenCalled();
  expect(api.discardSubmission).not.toHaveBeenCalled();
});

it.each(["aborted", "expired"] as const)(
  "rolls back a pending promotion whose reservation is %s",
  async (status) => {
    const pending = {
      conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
      reservationId: "550e8400-e29b-41d4-a716-446655440001",
      submissionId: "550e8400-e29b-41d4-a716-446655440000",
    };
    api.pendingPromotions.mockResolvedValue([pending]);
    api.reservationStatus.mockResolvedValue({ ...pending, status });
    api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [] });

    renderHost("/settings");

    await waitFor(() => expect(api.rollbackPromotion).toHaveBeenCalled());
    expect(api.discardSubmission).toHaveBeenCalled();
    expect(api.abortReservation).not.toHaveBeenCalled();
    expect(api.commitPromotion).not.toHaveBeenCalled();
  },
);

it("retains a pending promotion when reservation status is unreachable", async () => {
  const pending = {
    conversationId: "01990f4e-6650-7a33-a768-611e2e4bf4c7",
    reservationId: "550e8400-e29b-41d4-a716-446655440001",
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
  };
  api.pendingPromotions.mockResolvedValue([pending]);
  api.reservationStatus.mockRejectedValue(new Error("Server unreachable"));
  api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [] });

  renderHost("/settings");

  await waitFor(() => expect(api.reservationStatus).toHaveBeenCalled());
  expect(api.commitPromotion).not.toHaveBeenCalled();
  expect(api.rollbackPromotion).not.toHaveBeenCalled();
  expect(api.discardSubmission).not.toHaveBeenCalled();
  expect(api.abortReservation).not.toHaveBeenCalled();
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

it("starts queued Work with this app's executor and the folders attached now", async () => {
  api.snapshot.mockResolvedValue({ attempts: [], calls: [], settings: [], queued: ["q1"] });
  api.dispatch.mockResolvedValue({ started: true });
  renderHost("/settings");
  await waitFor(() =>
    expect(api.dispatch).toHaveBeenCalledWith({
      data: {
        conversationId: "q1",
        fromDesktop: true,
        // The workspace first, as for any send; a folder that has gone missing
        // is left out.
        desktopFolders: [
          { name: WORKSPACE_FOLDER_NAME, path: "/work/q1" },
          { name: "site", path: "/code/site" },
        ],
        desktopCommands: true,
        desktopBrowser: false,
        desktopExecutorId: "executor",
      },
    }),
  );
});

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
