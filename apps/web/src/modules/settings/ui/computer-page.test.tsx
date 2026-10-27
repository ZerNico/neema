import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ComputerPage } from "./computer-page.tsx";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const server = vi.hoisted(() => ({
  grants: [] as Array<{
    id: string;
    host: string;
    port: number;
    privateNetwork: boolean;
    conversationId: string | null;
  }>,
  machines: [] as Array<Record<string, unknown>>,
  removeNetworkGrant: vi.fn(),
  renameComputer: vi.fn(),
  listed: vi.fn(),
  moveChatsHere: vi.fn(),
}));
vi.mock("~/modules/computer/server/functions.ts", () => ({
  listNetworkGrants: server.listed,
  removeNetworkGrant: server.removeNetworkGrant,
  renameComputer: server.renameComputer,
  computerSnapshot: async () => ({ machines: server.machines, pending: [] }),
  decideComputerCall: vi.fn(),
  moveChatHere: vi.fn(),
  moveChatsHere: server.moveChatsHere,
  resetChatEnvironment: vi.fn(),
}));

type Status = {
  status: string;
  progress?: number;
  reason?: string;
  remote: boolean;
  agentSocket: string | null;
};
const machine = vi.hoisted(() => ({
  client: null as null | Record<string, unknown>,
}));
vi.mock("~/modules/desktop/client/bridge.ts", () => ({
  useDesktop: () => machine.client,
  useLocalMachineId: () => (machine.client ? "laptop" : null),
}));

const desktop = (initial: Status) => {
  let status = initial;
  const client = {
    computerStatus: vi.fn(() => Effect.succeed(status)),
    setRemoteControl: vi.fn(({ enabled }: { enabled: boolean }) =>
      Effect.sync(() => (status = { ...status, remote: enabled })),
    ),
    setAgentSocket: vi.fn(({ path }: { path: string | null }) =>
      Effect.sync(() => (status = { ...status, agentSocket: path })),
    ),
  };
  machine.client = client;
  return client;
};

const renderPage = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ConfirmProvider>
        <ComputerPage />
      </ConfirmProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  server.grants = [];
  server.machines = [];
  server.removeNetworkGrant.mockReset().mockResolvedValue({ removed: true });
  server.renameComputer.mockReset().mockResolvedValue({ renamed: true });
  server.moveChatsHere.mockReset().mockResolvedValue({ moved: 2 });
  server.listed.mockReset().mockImplementation(async () => ({ grants: server.grants }));
  machine.client = null;
});

describe("ComputerPage", () => {
  it("says where this computer's settings live when opened in a web browser", () => {
    renderPage();
    expect(screen.getByText("Only in neema Desktop")).toBeInTheDocument();
  });

  it("leaves out the list of destinations until one is allowed everywhere", async () => {
    server.grants = [
      { id: "g1", host: "github.com", port: 22, privateNetwork: false, conversationId: "c1" },
    ];
    renderPage();
    // A chat's own grant is that chat's; the page lists only those for every chat.
    await waitFor(() => expect(server.listed).toHaveBeenCalled());
    await act(() => server.listed.mock.results[0]!.value);
    expect(screen.queryByText("Internet access")).toBeNull();
  });

  it("lists destinations every chat may reach, ports only past HTTPS's, and removes one after confirming", async () => {
    const user = userEvent.setup();
    server.grants = [
      { id: "g1", host: "github.com", port: 22, privateNetwork: false, conversationId: null },
      { id: "g2", host: "git.internal", port: 443, privateNetwork: true, conversationId: null },
      {
        id: "g3",
        host: "chat-only.example",
        port: 443,
        privateNetwork: false,
        conversationId: "c1",
      },
    ];
    renderPage();
    expect(await screen.findByText("github.com:22")).toBeInTheDocument();
    expect(screen.getByText("git.internal")).toBeInTheDocument();
    // A chat's own destinations live in its computer menu.
    expect(screen.queryByText("chat-only.example")).toBeNull();
    const row = screen.getByText("github.com:22").closest("li, div")!;
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Remove" }));
    expect(server.removeNetworkGrant).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Remove", hidden: false }));
    await waitFor(() =>
      expect(server.removeNetworkGrant).toHaveBeenCalledWith({ data: { grantId: "g1" } }),
    );
  });

  it("shows this computer's status, remote use and agent socket in the desktop app", async () => {
    const user = userEvent.setup();
    const client = desktop({
      status: "preparing",
      progress: 0.42,
      remote: true,
      agentSocket: null,
    });
    renderPage();
    expect(await screen.findByText("Getting ready, 42%")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow from your other devices" }));
    expect(client.setRemoteControl).toHaveBeenCalledWith({ enabled: false });
    await user.type(screen.getByRole("textbox", { name: "SSH agent" }), "/tmp/agent.sock");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(client.setAgentSocket).toHaveBeenCalledWith({ path: "/tmp/agent.sock" });
  });

  it("lists the person's computers and whether each is online", async () => {
    server.machines = [
      {
        id: "a",
        name: "Studio Mac",
        platform: "darwin",
        lastSeenAt: new Date(0).toISOString(),
        online: true,
        computer: { status: "ready" },
        remote: true,
      },
      {
        id: "b",
        name: "Old laptop",
        platform: "linux",
        lastSeenAt: new Date(0).toISOString(),
        online: false,
        computer: null,
        remote: null,
      },
    ];
    renderPage();
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText(/^Offline since/)).toBeInTheDocument();
  });
});

describe("the list of computers", () => {
  it("renames a computer in place, and marks the one this is", async () => {
    desktop({ status: "ready", remote: true, agentSocket: null });
    server.machines = [
      {
        id: "laptop",
        name: "MacBook Pro",
        platform: "darwin",
        lastSeenAt: new Date().toISOString(),
        online: true,
        computer: null,
        remote: true,
      },
    ];
    renderPage();
    expect(await screen.findByText("MacBook Pro")).toBeInTheDocument();
    expect(screen.getAllByText("This computer").length).toBeGreaterThan(1);
    await userEvent.click(screen.getByRole("button", { name: "Rename MacBook Pro" }));
    const field = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Work laptop{Enter}");
    await waitFor(() =>
      expect(server.renameComputer).toHaveBeenCalledWith({
        data: { machineId: "laptop", name: "Work laptop" },
      }),
    );
  });
});

describe("moving chats", () => {
  it("moves every chat of another computer here after confirming", async () => {
    desktop({ status: "ready", remote: true, agentSocket: null });
    server.machines = [
      {
        id: "laptop",
        name: "New MacBook",
        platform: "darwin",
        lastSeenAt: new Date().toISOString(),
        online: true,
        computer: null,
        remote: true,
      },
      {
        id: "old",
        name: "Old MacBook",
        platform: "darwin",
        lastSeenAt: new Date().toISOString(),
        online: false,
        computer: null,
        remote: true,
      },
    ];
    renderPage();
    // One button, on the other computer's row only.
    const buttons = await screen.findAllByRole("button", { name: "Move chats here" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Move chats here",
      }),
    );
    await waitFor(() =>
      expect(server.moveChatsHere).toHaveBeenCalledWith({ data: { fromMachineId: "old" } }),
    );
  });
});
