import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  isCancelledError,
} from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BridgeReply, type FolderStatus } from "@chat/desktop-rpc";
import {
  desktopAttemptFields,
  folderQueryKey,
  prepareWorkFolder,
  requireWorkFolder,
  useFolder,
} from "~/modules/desktop/client/bridge.ts";
import { useWorkGate } from "~/modules/desktop/client/use-work-gate.ts";
import { Composer } from "./composer.tsx";

vi.mock("../server/functions.ts", () => ({
  listChatModels: vi.fn(),
  getConversationWithMessages: async () => ({
    conversation: { id: "01990f4e-6650-7a33-a768-611e2e4bf4c7", mode: "work" },
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

const CONVERSATION_A = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const CONVERSATION_B = "01990f4e-6650-7a33-a768-611e2e4bf4c8";
const request = vi.fn<(tag: string, payload: unknown) => Promise<BridgeReply>>();
const empty: FolderStatus = {
  folders: [],
  sandbox: { kind: "ready" },
  workspace: { path: "/data/workspaces/a" },
};
const attached: FolderStatus = {
  folders: [{ name: "site", path: "/home/user/site", alive: true }],
  sandbox: { kind: "ready" },
  workspace: { path: "/data/workspaces/a" },
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
  vi.stubGlobal("__chatDesktop", {
    protocolVersion: PROTOCOL_VERSION,
    request,
    stageDroppedFile: async () => null,
  });
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
  const work = useWorkGate(CONVERSATION_A, working);
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
    const work = useWorkGate(CONVERSATION_A, true);
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
      desktopFolders: [
        { name: "workspace", path: "/data/workspaces/a" },
        { name: "site", path: "/home/user/site" },
      ],
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
      desktopFolders: [{ name: "workspace", path: "/data/workspaces/a" }],
      desktopCommands: true,
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
    (payload as { conversationId: string }).conversationId === CONVERSATION_A
      ? a.promise
      : b.promise,
  );
  const { wrapper, client } = setup();
  const { result, rerender } = renderHook(({ id }) => useFolder(id), {
    wrapper,
    initialProps: { id: CONVERSATION_A },
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender({ id: CONVERSATION_B });
  expect(result.current?.readiness).toBe("loading");
  await act(async () => a.resolve(reply(attached)));
  expect(result.current?.status).toBeNull();
  await act(async () => b.resolve(reply(empty)));
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  expect(result.current?.status).toEqual(empty);
  expect(client.getQueryData(folderQueryKey(CONVERSATION_A))).toBeUndefined();
});

it("cancels a delayed focus refresh before applying a folder mutation", async () => {
  const { wrapper, client } = setup();
  const { result } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
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
  expect(client.getQueryData(folderQueryKey(CONVERSATION_A))).toEqual(attached);
});

it("writes a delayed mutation to its captured conversation, not the newly opened one", async () => {
  const { wrapper, client } = setup();
  const { result, rerender } = renderHook(({ id }) => useFolder(id), {
    wrapper,
    initialProps: { id: CONVERSATION_A },
  });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "chooseFolder" ? chosen.promise : Promise.resolve(reply(empty)),
  );
  act(() => result.current?.choose());
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("chooseFolder", { conversationId: CONVERSATION_A }),
  );
  rerender({ id: CONVERSATION_B });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  await act(async () => chosen.resolve(reply(attached)));
  await waitFor(() =>
    expect(client.getQueryData(folderQueryKey(CONVERSATION_A))).toEqual(attached),
  );
  expect(result.current?.status).toEqual(empty);
});

it.each(["query", "mutation"])(
  "does not repopulate an identity-cleared cache from late %s IPC",
  async (kind) => {
    const pending = deferred<BridgeReply>();
    if (kind === "query") request.mockReturnValue(pending.promise);
    const { wrapper, client } = setup();
    const { result, unmount } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
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

it("deduplicates concurrent preparation, refreshes on re-entry, and retains focus refresh", async () => {
  const { client, wrapper } = setup();
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const first = prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal);
  const second = prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  pending.resolve(reply(empty));
  await Promise.all([first, second]);
  const { result } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
  expect(result.current?.status).toEqual(empty);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue(reply(attached));
  await act(async () => prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal));
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
  const { result } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const read = deferred<BridgeReply>();
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) => (tag === "chooseFolder" ? chosen.promise : read.promise));
  const prepared = prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  request.mockResolvedValue(reply(attached));
  await act(async () => chosen.resolve(reply(attached)));
  await prepared;
  read.resolve(reply(empty));
  expect(client.getQueryData(folderQueryKey(CONVERSATION_A))).toEqual(attached);
  expect(request).toHaveBeenCalledTimes(4);
});

it("mounts a prepared IPC error without retrying until explicitly requested", async () => {
  const { client, wrapper } = setup();
  request.mockResolvedValue({
    ok: false,
    error: { _tag: "DesktopError", reason: "failed", message: "Offline" },
  });
  await prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal);
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
  const { result } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const chosen = deferred<BridgeReply>();
  request.mockImplementation((tag) =>
    tag === "chooseFolder" ? chosen.promise : Promise.resolve(reply(attached)),
  );
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const settled = vi.fn();
  const prepared = prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal).then(
    settled,
  );
  expect(settled).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => chosen.resolve(reply(attached)));
  await prepared;
  expect(client.getQueryData(folderQueryKey(CONVERSATION_A))).toEqual(attached);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["route", "identity", "read"])(
  "does not accept %s cancellation as a settled folder result",
  async (kind) => {
    const { client } = setup();
    const pending = deferred<BridgeReply>();
    request.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const prepared = prepareWorkFolder(client, CONVERSATION_A, controller.signal);
    const cancelled = prepared.then(
      () => false,
      (error) => isCancelledError(error),
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    if (kind === "route") controller.abort();
    else if (kind === "identity") client.clear();
    else await client.cancelQueries();
    expect(await cancelled).toBe(true);
    pending.resolve(reply(attached));
    if (kind === "identity")
      expect(client.getQueryState(folderQueryKey(CONVERSATION_A))).toBeUndefined();
  },
);

it("cancels a mutation wait on identity teardown without recreating its query", async () => {
  const { client, wrapper } = setup();
  const { result, unmount } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  act(() => result.current?.choose());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const prepared = prepareWorkFolder(client, CONVERSATION_A, new AbortController().signal);
  const cancelled = prepared.then(
    () => false,
    (error) => isCancelledError(error),
  );
  unmount();
  client.clear();
  expect(await cancelled).toBe(true);
  await act(async () => pending.resolve(reply(attached)));
  expect(client.getQueryState(folderQueryKey(CONVERSATION_A))).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects unresolved Work attempts before session IPC, while ready-empty remains valid", async () => {
  const pending = deferred<BridgeReply>();
  request.mockReturnValue(pending.promise);
  const { wrapper } = setup();
  const { result } = renderHook(() => useFolder(CONVERSATION_A), { wrapper });
  expect(() => requireWorkFolder(true, result.current)).toThrow("folder check");
  expect(requireWorkFolder(false, result.current)).toBeNull();
  await act(async () => pending.resolve(reply(empty)));
  await waitFor(() => expect(result.current?.readiness).toBe("ready"));
  request.mockResolvedValue(
    reply({ id: "executor", machineId: "machine-a", machineName: "Test Mac" }),
  );
  expect(await desktopAttemptFields(requireWorkFolder(true, result.current))).toEqual({
    fromDesktop: true,
    desktopFolders: [{ name: "workspace", path: "/data/workspaces/a" }],
    desktopCommands: true,
    desktopExecutorId: "executor",
    desktopMachineId: "machine-a",
    desktopMachineName: "Test Mac",
  });
});
