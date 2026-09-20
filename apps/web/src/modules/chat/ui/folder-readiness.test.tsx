import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  isCancelledError,
} from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { Route as ChatRoute } from "~/routes/_app.chat.$conversationId.tsx";
import { Route as NewChatRoute } from "~/routes/_app.index.tsx";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BridgeReply, type FolderStatus } from "@chat/desktop-rpc";
import {
  DRAFT_CONVERSATION,
  desktopAttemptFields,
  folderQueryKey,
  prepareWorkFolder,
  requireWorkFolder,
  useFolder,
  waitForDraftBinding,
  withDraftFolderBinding,
} from "~/modules/desktop/client/bridge.ts";
import { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import { Composer } from "./composer.tsx";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  getConversationWithMessages: async () => ({
    conversation: { id: "a", mode: "work" },
    messages: [],
  }),
}));
vi.mock("~/modules/agents/server/functions.ts", () => ({ listAgents: async () => [] }));
// The route uses its actual loader; its component below mounts the real Composer.
vi.mock("./chat-view.tsx", () => ({ ChatView: () => null, NewChatView: () => null }));
vi.mock("~/modules/skills/server/functions.ts", () => ({ listSkills: async () => [] }));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getWebSearchAvailability: async () => ({ configured: false, enabled: false }),
  getResearchAvailability: async () => ({ configured: false, enabled: false }),
}));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: async () => ({ configured: false, enabled: false }),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

const request = vi.fn<(tag: string, payload: unknown) => Promise<BridgeReply>>();
const empty: FolderStatus = { folders: [], sandbox: { kind: "ready" } };
const attached: FolderStatus = {
  folders: [{ name: "site", path: "/home/user/site", alive: true }],
  sandbox: { kind: "ready" },
};
const reply = (value: unknown): BridgeReply => ({ ok: true, value });
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(
    ["chat-models"],
    [
      {
        id: "m1",
        providerId: "p1",
        providerName: "Provider",
        modelKey: "model",
        displayName: "Model",
        type: "chat",
        enabled: true,
        contextLength: 128000,
        capabilities: { tools: true, reasoning: false, files: false, vision: false },
      },
    ],
  );
  return {
    client,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(reply(empty));
  vi.stubGlobal("__chatDesktop", { protocolVersion: PROTOCOL_VERSION, request });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function WorkComposer({
  onSend,
  working = true,
}: {
  onSend: () => Promise<unknown>;
  working?: boolean;
}) {
  const work = useWorkGate("a", working);
  return (
    <Composer
      folder={work.folder}
      readOnly={work.readOnly}
      mode={{ kind: "fixed", value: working ? "work" : "chat" }}
      onSend={onSend}
      disabled={false}
      modelId="m1"
      onModelChange={() => {}}
      searchEnabled={false}
      onSearchEnabledChange={() => {}}
    />
  );
}

it("blocks Work while IPC is unresolved, offers retry on failure, then permits ready-empty", async () => {
  const pending = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "folderStatus" ? pending.promise : Promise.resolve(reply(empty)),
  );
  const { wrapper } = setup();
  const send = vi.fn().mockResolvedValue(undefined);
  render(<WorkComposer onSend={send} />, { wrapper });
  expect(screen.getByText("Checking folders…")).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBeEnabled();
  expect(screen.queryByText("Add a folder from this computer")).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole("textbox"), "Continue{Enter}");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  await act(async () =>
    pending.resolve({
      ok: false,
      error: { _tag: "DesktopError", reason: "failed", message: "Offline" },
    }),
  );
  await screen.findByText("Could not check folders.");
  request.mockResolvedValue(reply(empty));
  await userEvent.click(screen.getByRole("button", { name: "Retry folder check" }));
  await screen.findByText("Add a folder from this computer");
  expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledOnce();
});

it("blocks submission during a picker and uses its result for the next Work attempt", async () => {
  const chosen = deferred<BridgeReply>();
  const machine = { id: "executor", machineId: "machine-a", machineName: "Test Mac" };
  request.mockImplementation((tag) => {
    if (tag === "chooseFolder") return chosen.promise;
    if (tag === "executionSession") return Promise.resolve(reply(machine));
    return Promise.resolve(reply(empty));
  });
  const { wrapper } = setup();
  const sent = vi.fn();
  function SharedFolder() {
    const work = useWorkGate("a", true);
    return (
      <Composer
        folder={work.folder}
        readOnly={work.readOnly}
        mode={{ kind: "fixed", value: "work" }}
        onSend={async () => sent(await work.attemptFields())}
        disabled={false}
        modelId="m1"
        onModelChange={() => {}}
        searchEnabled={false}
        onSearchEnabledChange={() => {}}
      />
    );
  }
  render(<SharedFolder />, { wrapper });
  await userEvent.click(
    await screen.findByRole("button", { name: "Add a folder from this computer" }),
  );
  expect(screen.getByRole("textbox")).toBeEnabled();
  await userEvent.type(screen.getByRole("textbox"), "Use the folder{Enter}");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(sent).not.toHaveBeenCalled();
  await act(async () => chosen.resolve(reply(attached)));
  await screen.findByRole("button", { name: "site" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(sent).toHaveBeenCalledWith({
      fromDesktop: true,
      desktopFolders: [{ name: "site", path: "/home/user/site" }],
      desktopCommands: true,
      desktopExecutorId: "executor",
      desktopMachineId: "machine-a",
      desktopMachineName: "Test Mac",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "site" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Detach site" }));
  await screen.findByRole("button", { name: "Add a folder from this computer" });
  await userEvent.type(screen.getByRole("textbox"), "Continue{Enter}");
  await waitFor(() =>
    expect(sent).toHaveBeenLastCalledWith({
      fromDesktop: true,
      desktopCommands: false,
      desktopExecutorId: "executor",
      desktopMachineId: "machine-a",
      desktopMachineName: "Test Mac",
    }),
  );
});

it("does not block plain chat on unresolved folder IPC", async () => {
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const { wrapper } = setup();
  const send = vi.fn().mockResolvedValue(undefined);
  render(<WorkComposer working={false} onSend={send} />, { wrapper });
  await userEvent.type(screen.getByRole("textbox"), "Hello{Enter}");
  expect(send).toHaveBeenCalledOnce();
});

it("never projects conversation A's delayed reply into conversation B", async () => {
  const a = deferred<BridgeReply>();
  const b = deferred<BridgeReply>();
  request.mockImplementation((_tag, payload) =>
    (payload as { conversationId: string }).conversationId === "a" ? a.promise : b.promise,
  );
  const { wrapper, client } = setup();
  const { result, rerender } = renderHook(({ id }) => useFolder(id), {
    wrapper,
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender({ id: "b" });
  expect(result.current?.readiness).toBe("loading");
  await act(async () => a.resolve(reply(attached)));
  expect(result.current?.status).toBeNull();
  await act(async () => b.resolve(reply(empty)));
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  expect(result.current?.status).toEqual(empty);
  expect(client.getQueryData(folderQueryKey("a"))).toBeUndefined();
});

it("cancels a delayed focus refresh before applying a folder mutation", async () => {
  const { wrapper, client } = setup();
  const { result } = renderHook(() => useFolder("a"), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const refresh = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "folderStatus" ? refresh.promise : Promise.resolve(reply(attached)),
  );
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  act(() => result.current?.choose());
  await waitFor(() => expect(result.current?.status).toEqual(attached));
  await act(async () => refresh.resolve(reply(empty)));
  expect(client.getQueryData(folderQueryKey("a"))).toEqual(attached);
});

it("writes a delayed mutation to its captured conversation, not the newly opened one", async () => {
  const { wrapper, client } = setup();
  const { result, rerender } = renderHook(({ id }) => useFolder(id), {
    wrapper,
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "chooseFolder" ? chosen.promise : Promise.resolve(reply(empty)),
  );
  act(() => result.current?.choose());
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("chooseFolder", { conversationId: "a" }),
  );
  rerender({ id: "b" });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  await act(async () => chosen.resolve(reply(attached)));
  await waitFor(() => expect(client.getQueryData(folderQueryKey("a"))).toEqual(attached));
  expect(result.current?.status).toEqual(empty);
});

it.each(["query", "mutation"])(
  "does not repopulate an identity-cleared cache from late %s IPC",
  async (kind) => {
    const pending = deferred<BridgeReply>();
    if (kind === "query") request.mockReturnValue(pending.promise);
    const { wrapper, client } = setup();
    const { result, unmount } = renderHook(() => useFolder("a"), { wrapper });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (kind === "mutation") {
      await waitFor(() => expect(result.current?.readiness).toBe("ready"));
      request.mockReturnValue(pending.promise);
      act(() => result.current?.choose());
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    }
    unmount();
    await client.cancelQueries();
    client.clear();
    await act(async () => pending.resolve(reply(attached)));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  },
);

it("holds the dispatch barrier through draft rebind and invalidates both folder keys", async () => {
  const { client } = setup();
  client.setQueryData(folderQueryKey(DRAFT_CONVERSATION), attached);
  client.setQueryData(folderQueryKey("new"), empty);
  const rebound = deferred<BridgeReply>();
  request.mockReturnValue(rebound.promise);
  const send = withDraftFolderBinding(async () => ({ conversationId: "new" }), client);
  const released = vi.fn();
  const barrier = waitForDraftBinding().then(released);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("rebindFolder", {
      fromConversationId: DRAFT_CONVERSATION,
      toConversationId: "new",
    }),
  );
  expect(released).not.toHaveBeenCalled();
  rebound.resolve(reply(attached));
  await send;
  await barrier;
  expect(client.getQueryState(folderQueryKey(DRAFT_CONVERSATION))?.isInvalidated).toBe(true);
  expect(client.getQueryState(folderQueryKey("new"))?.isInvalidated).toBe(true);
});

it("does not stall other conversations after the create response names the destination", async () => {
  const { client } = setup();
  const created = deferred<{ conversationId: string }>();
  const rebound = deferred<BridgeReply>();
  request.mockReturnValue(rebound.promise);
  let sending = false;
  const send = withDraftFolderBinding(async () => {
    sending = true;
    return created.promise;
  }, client);
  await waitFor(() => expect(sending).toBe(true));
  const otherDone = vi.fn();
  const destDone = vi.fn();
  void waitForDraftBinding("other").then(otherDone);
  void waitForDraftBinding("new").then(destDone);
  await Promise.resolve();
  expect(otherDone).not.toHaveBeenCalled();
  expect(destDone).not.toHaveBeenCalled();
  created.resolve({ conversationId: "new" });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("rebindFolder", {
      fromConversationId: DRAFT_CONVERSATION,
      toConversationId: "new",
    }),
  );
  await waitFor(() => expect(otherDone).toHaveBeenCalled());
  expect(destDone).not.toHaveBeenCalled();
  rebound.resolve(reply(attached));
  await send;
  await waitFor(() => expect(destDone).toHaveBeenCalled());
});

it("returns the created conversation when rebind fails", async () => {
  const { client } = setup();
  request.mockRejectedValue(new Error("offline"));
  await expect(
    withDraftFolderBinding(async () => ({ conversationId: "new" }), client),
  ).resolves.toEqual({ conversationId: "new" });
  expect(request).toHaveBeenCalledWith("rebindFolder", {
    fromConversationId: DRAFT_CONVERSATION,
    toConversationId: "new",
  });
});

it.each(["conversation", "draft"])(
  "prepares %s folders before the routed Composer’s first commit",
  async (kind) => {
    const pending = deferred<BridgeReply>();
    request.mockReturnValue(pending.promise);
    const { client, wrapper } = setup();
    const commits = vi.fn();
    const id = kind === "draft" ? DRAFT_CONVERSATION : "a";
    function RoutedComposer() {
      const folder = useFolder(id);
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        commits(ref.current?.textContent);
      }, []);
      return (
        <div ref={ref}>
          <Composer
            folder={folder}
            mode={{ kind: "fixed", value: "work" }}
            settings={{ permissionLevel: "manual", onChange: () => {} }}
            onSend={async () => {}}
            disabled={false}
            modelId="m1"
            onModelChange={() => {}}
            searchEnabled={false}
            onSearchEnabledChange={() => {}}
          />
        </div>
      );
    }
    const root = createRootRouteWithContext<{ queryClient: QueryClient }>()();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/$conversationId",
      loader: (args) => {
        const loader = (kind === "draft" ? NewChatRoute : ChatRoute).options.loader;
        return (
          loader as (input: {
            context: { queryClient: QueryClient };
            params: { conversationId: string };
            abortController: AbortController;
          }) => Promise<void>
        )(args);
      },
      component: RoutedComposer,
    });
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/a"] }),
      context: { queryClient: client },
    });
    render(<RouterProvider router={router} />, { wrapper });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("folderStatus", { conversationId: id }),
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(commits).not.toHaveBeenCalled();
    await act(async () => pending.resolve(reply(attached)));
    await screen.findByRole("button", { name: "site" });
    expect(commits).toHaveBeenCalledOnce();
    expect(commits.mock.calls[0]?.[0]).toContain("site");
    expect(commits.mock.calls[0]?.[0]).toContain("Approve each action");
    expect(screen.queryByText("Checking folders…")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { outcome: "ready", preload: false },
  { outcome: "error", preload: false },
  { outcome: "ready", preload: true },
  { outcome: "error", preload: true },
])(
  "keeps a loader-owned read alive on outgoing unmount ($outcome, preload=$preload)",
  async ({ outcome, preload }) => {
    const { client, wrapper } = setup();
    const commits = vi.fn();
    const outgoingUnmounted = vi.fn();
    function Outgoing() {
      useFolder(DRAFT_CONVERSATION);
      useLayoutEffect(() => () => outgoingUnmounted(), []);
      return <div>Outgoing chat</div>;
    }
    function Destination() {
      const folder = useFolder(DRAFT_CONVERSATION);
      useLayoutEffect(() => {
        commits(folder?.readiness);
      }, [folder?.readiness]);
      return <div>Destination {folder?.readiness}</div>;
    }
    const root = createRootRouteWithContext<{ queryClient: QueryClient }>()();
    const outgoing = createRoute({
      getParentRoute: () => root,
      path: "/outgoing",
      component: Outgoing,
    });
    const destination = createRoute({
      getParentRoute: () => root,
      path: "/",
      loader: (args) =>
        (
          NewChatRoute.options.loader as (input: {
            context: { queryClient: QueryClient };
            abortController: AbortController;
          }) => Promise<void>
        )(args),
      component: Destination,
      pendingComponent: () => <div>Preparing destination</div>,
      errorComponent: ({ error }) => <div>Route error: {String(error)}</div>,
      pendingMs: 1000,
      pendingMinMs: 0,
    });
    const router = createRouter({
      routeTree: root.addChildren([outgoing, destination]),
      history: createMemoryHistory({ initialEntries: ["/outgoing"] }),
      context: { queryClient: client },
    });
    render(<RouterProvider router={router} />, { wrapper });
    await screen.findByText("Outgoing chat");
    await waitFor(() =>
      expect(client.getQueryData(folderQueryKey(DRAFT_CONVERSATION))).toEqual(empty),
    );
    const pending = deferred<BridgeReply>();
    const started = deferred<void>();
    request.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    let preloaded: ReturnType<typeof router.preloadRoute> | undefined;
    if (preload) {
      await act(async () => {
        preloaded = router.preloadRoute({ to: "/" });
        await started.promise;
      });
    }
    vi.useFakeTimers();
    let navigation!: Promise<void>;
    await act(async () => {
      navigation = router.navigate({ to: "/" });
      await started.promise;
    });
    expect(outgoingUnmounted).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    await screen.findByText("Preparing destination");
    await waitFor(() => expect(outgoingUnmounted).toHaveBeenCalledOnce());
    expect(commits).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(
        outcome === "ready"
          ? reply(attached)
          : {
              ok: false,
              error: { _tag: "DesktopError", reason: "failed", message: "Offline" },
            },
      );
      await navigation;
      await preloaded;
    });
    // Outgoing already cached a status, so a failed refetch stays ready
    // rather than looking like a missing folder.
    await screen.findByText("Destination ready");
    expect(commits).toHaveBeenCalledExactlyOnceWith("ready");
    expect(screen.queryByText(/Route error/)).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("abandons a superseded folder navigation without rendering cancellation or reviving its query", async () => {
  const { client, wrapper } = setup();
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const commits = vi.fn();
  function Destination() {
    const folder = useFolder(DRAFT_CONVERSATION);
    useLayoutEffect(() => {
      commits(folder?.readiness);
    }, [folder?.readiness]);
    return <div>Destination</div>;
  }
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const start = createRoute({
    getParentRoute: () => root,
    path: "/login",
    component: () => <div>Start</div>,
  });
  const destination = createRoute({
    getParentRoute: () => root,
    path: "/",
    loader: (args) =>
      (
        NewChatRoute.options.loader as (input: {
          context: { queryClient: QueryClient };
          abortController: AbortController;
        }) => Promise<void>
      )(args),
    component: Destination,
    errorComponent: ({ error }) => <div>Route error: {String(error)}</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([start, destination]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
    context: { queryClient: client },
  });
  render(<RouterProvider router={router} />, { wrapper });
  await screen.findByText("Start");
  let navigation!: Promise<void>;
  act(() => {
    navigation = router.navigate({ to: "/" });
  });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  await act(async () => {
    await router.navigate({ to: "/login" });
    await navigation;
  });
  expect(screen.getByText("Start")).toBeInTheDocument();
  expect(commits).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .find({ queryKey: folderQueryKey(DRAFT_CONVERSATION) })
        ?.getObserversCount(),
    ).toBe(0),
  );
  client.clear();
  await act(async () => {
    pending.resolve(reply(attached));
  });
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(screen.queryByText(/Route error/)).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledOnce();
});

it("deduplicates concurrent preparation, refreshes on re-entry, and retains focus refresh", async () => {
  const { client, wrapper } = setup();
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const first = prepareWorkFolder(client, "a", new AbortController().signal);
  const second = prepareWorkFolder(client, "a", new AbortController().signal);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  pending.resolve(reply(empty));
  await Promise.all([first, second]);
  const { result } = renderHook(() => useFolder("a"), { wrapper });
  expect(result.current?.status).toEqual(empty);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue(reply(attached));
  await act(async () => prepareWorkFolder(client, "a", new AbortController().signal));
  await waitFor(() => expect(result.current?.status).toEqual(attached));
  expect(request).toHaveBeenCalledTimes(2);
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
});

it("restarts preparation if a picker cancels its in-flight read", async () => {
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useFolder("a"), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const read = deferred<BridgeReply>();
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) => (tag === "chooseFolder" ? chosen.promise : read.promise));
  const prepared = prepareWorkFolder(client, "a", new AbortController().signal);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  request.mockResolvedValue(reply(attached));
  await act(async () => chosen.resolve(reply(attached)));
  await prepared;
  read.resolve(reply(empty));
  expect(client.getQueryData(folderQueryKey("a"))).toEqual(attached);
  expect(request).toHaveBeenCalledTimes(4);
});

it("mounts a prepared IPC error without retrying until explicitly requested", async () => {
  const { client, wrapper } = setup();
  request.mockResolvedValue({
    ok: false,
    error: { _tag: "DesktopError", reason: "failed", message: "Offline" },
  });
  await prepareWorkFolder(client, "a", new AbortController().signal);
  render(<WorkComposer onSend={async () => {}} />, { wrapper });
  expect(screen.getByText("Could not check folders.")).toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue(reply(empty));
  await userEvent.click(screen.getByRole("button", { name: "Retry folder check" }));
  await screen.findByText("Add a folder from this computer");
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps cached folders when a focus refetch fails", async () => {
  request.mockResolvedValue(reply(attached));
  const { wrapper } = setup();
  render(<WorkComposer onSend={async () => {}} />, { wrapper });
  await screen.findByRole("button", { name: "site" });
  request.mockResolvedValue({
    ok: false,
    error: { _tag: "DesktopError", reason: "failed", message: "Offline" },
  });
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "site" })).toBeInTheDocument();
  expect(screen.queryByText("Could not check folders.")).not.toBeInTheDocument();
});

it("waits for a picker before preparing the destination of a navigation", async () => {
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useFolder("a"), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "chooseFolder" ? chosen.promise : Promise.resolve(reply(attached)),
  );
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const settled = vi.fn();
  const prepared = prepareWorkFolder(client, "a", new AbortController().signal).then(settled);
  expect(settled).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => chosen.resolve(reply(attached)));
  await prepared;
  expect(client.getQueryData(folderQueryKey("a"))).toEqual(attached);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["route", "identity", "read"])(
  "does not accept %s cancellation as a settled folder result",
  async (kind) => {
    const { client } = setup();
    const pending = deferred<BridgeReply>();
    request.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const prepared = prepareWorkFolder(client, "a", controller.signal);
    const rejected = expect(prepared).rejects.toSatisfy(isCancelledError);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (kind === "route") controller.abort();
    else if (kind === "identity") client.clear();
    else await client.cancelQueries();
    await rejected;
    pending.resolve(reply(attached));
    if (kind === "identity") expect(client.getQueryState(folderQueryKey("a"))).toBeUndefined();
  },
);

it("cancels a mutation wait on identity teardown without recreating its query", async () => {
  const { client, wrapper } = setup();
  const { result, unmount } = renderHook(() => useFolder("a"), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const prepared = prepareWorkFolder(client, "a", new AbortController().signal);
  const rejected = expect(prepared).rejects.toSatisfy(isCancelledError);
  unmount();
  client.clear();
  await rejected;
  await act(async () => pending.resolve(reply(attached)));
  expect(client.getQueryState(folderQueryKey("a"))).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});

it("waits through draft rebinding before preparing draft and destination state", async () => {
  const { client } = setup();
  const rebound = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "rebindFolder" ? rebound.promise : Promise.resolve(reply(attached)),
  );
  const send = withDraftFolderBinding(async () => ({ conversationId: "new" }), client);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const preparations = [DRAFT_CONVERSATION, "new"].map((id) =>
    prepareWorkFolder(client, id, new AbortController().signal),
  );
  expect(request).toHaveBeenCalledTimes(1);
  rebound.resolve(reply(attached));
  await send;
  await Promise.all(preparations);
  expect(request).toHaveBeenCalledTimes(3);
  expect(client.getQueryData(folderQueryKey("new"))).toEqual(attached);
});

it("rejects unresolved Work attempts before session IPC, while ready-empty remains valid", async () => {
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const { wrapper } = setup();
  const { result } = renderHook(() => useFolder("a"), { wrapper });
  expect(() => requireWorkFolder(true, result.current)).toThrow("folder check");
  expect(requireWorkFolder(false, result.current)).toBeNull();
  await act(async () => pending.resolve(reply(empty)));
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  request.mockResolvedValue(
    reply({ id: "executor", machineId: "machine-a", machineName: "Test Mac" }),
  );
  expect(await desktopAttemptFields(requireWorkFolder(true, result.current))).toEqual({
    fromDesktop: true,
    desktopCommands: false,
    desktopExecutorId: "executor",
    desktopMachineId: "machine-a",
    desktopMachineName: "Test Mac",
  });
});
