import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ComputerPage } from "./computer-page.tsx";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

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

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__chatDesktop");
});

describe("ComputerPage", () => {
  it("says where these settings live when opened in a web browser", () => {
    renderPage();
    expect(screen.getByText("Only in neema Desktop")).toBeInTheDocument();
  });

  const desktop = (overrides: Record<string, unknown> = {}) => {
    const network = {
      list: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue(undefined),
      listPaths: vi.fn().mockResolvedValue([]),
      revokePath: vi.fn().mockResolvedValue(undefined),
      localServices: vi.fn().mockResolvedValue("asked"),
      allowLocal: vi.fn().mockResolvedValue(true),
      revokeLocal: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    Reflect.set(globalThis, "__chatDesktop", { network });
    return network;
  };

  it("lists destinations, ports only past HTTPS's, and removes one only after confirming", async () => {
    const user = userEvent.setup();
    const ssh = { host: "github.com", port: 22, privateNetwork: false };
    const internal = { host: "git.internal", port: 443, privateNetwork: true };
    const network = desktop({ list: vi.fn().mockResolvedValue([ssh, internal]) });
    renderPage();

    expect(await screen.findByText("github.com:22")).toBeInTheDocument();
    expect(screen.getByText("git.internal")).toBeInTheDocument();
    expect(screen.getByText("Your network")).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "This computer",
      "Internet access",
      "Services on this computer",
      "Files and folders",
    ]);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove github.com:22?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(network.revoke).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(network.revoke).toHaveBeenCalledWith(internal));
    await waitFor(() => expect(network.list).toHaveBeenCalledTimes(2));
  });

  it("lists readable paths and removes one", async () => {
    const user = userEvent.setup();
    const network = desktop({ listPaths: vi.fn().mockResolvedValue(["/opt/specs"]) });
    renderPage();
    expect(await screen.findByText("/opt/specs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(network.revokePath).toHaveBeenCalledWith("/opt/specs"));
  });

  it("allows services on this computer through the app, and stops without asking", async () => {
    const user = userEvent.setup();
    const network = desktop({
      localServices: vi.fn().mockResolvedValueOnce("asked").mockResolvedValue("allowed"),
    });
    renderPage();
    const toggle = await screen.findByRole("switch", {
      name: "Allow services on this computer in every chat",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(network.allowLocal).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    await waitFor(() => expect(network.revokeLocal).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("leaves out services on this computer where commands have their own", async () => {
    desktop({ localServices: vi.fn().mockResolvedValue("unavailable") });
    renderPage();
    expect(await screen.findByText("Internet access")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Services on this computer")).not.toBeInTheDocument(),
    );
  });

  it("shows loading, failure and an empty list as rows of the same card", async () => {
    const user = userEvent.setup();
    desktop({ list: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this list.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByText("Nothing yet.")).toHaveLength(2);
  });
  const agentSetting = (overrides: Record<string, unknown> = {}) => ({
    current: {
      socket: "/tmp/launchd/Listeners",
      name: null,
      source: "environment",
      running: true,
      keys: 0,
    },
    found: [],
    choosable: true,
    ...overrides,
  });

  it("names the agent in use and offers the known ones found, another socket or the default", async () => {
    const user = userEvent.setup();
    const onePassword = "/Users/me/Library/Group Containers/op/agent.sock";
    const fallback = agentSetting({ found: [{ name: "1Password", socket: onePassword }] });
    const chosen = agentSetting({
      current: { socket: onePassword, name: "1Password", source: "chosen", running: true, keys: 2 },
      found: [{ name: "1Password", socket: onePassword }],
    });
    const chooseAgent = vi.fn().mockResolvedValue({ ok: true, changed: true });
    desktop({
      agent: vi.fn().mockResolvedValueOnce(fallback).mockResolvedValue(chosen),
      chooseAgent,
    });
    renderPage();

    expect(await screen.findByText("System agent")).toBeInTheDocument();
    expect(screen.getByText("No keys. Add yours with ssh-add.")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/launchd/Listeners")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(await screen.findByRole("menuitem", { name: "1Password" }));
    expect(chooseAgent).toHaveBeenCalledWith(onePassword);
    expect(await screen.findByText("1Password")).toBeInTheDocument();
    expect(screen.getByText("2 keys")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.queryByRole("menuitem", { name: "1Password" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "System agent" }));
    expect(chooseAgent).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(await screen.findByRole("menuitem", { name: "Other agent…" }));
    await user.type(await screen.findByLabelText("Agent socket"), "/Users/me/agent.sock");
    await user.click(screen.getByRole("button", { name: "Use" }));
    expect(chooseAgent).toHaveBeenLastCalledWith("/Users/me/agent.sock");
    await waitFor(() => expect(screen.queryByLabelText("Agent socket")).not.toBeInTheDocument());
  });

  it("says why the app refused a socket, and nothing when the person cancelled", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    vi.mocked(toast.error).mockClear();
    const chooseAgent = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        message: "/x didn’t answer as an SSH agent. Is it running?",
      })
      .mockResolvedValueOnce({ ok: true, changed: false });
    desktop({ agent: vi.fn().mockResolvedValue(agentSetting({ current: null })), chooseAgent });
    renderPage();

    expect(await screen.findByText("No agent found")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(await screen.findByRole("menuitem", { name: "Other agent…" }));
    const input = await screen.findByLabelText("Agent socket");
    await user.type(input, "/x");
    await user.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls[0])).toContain("didn’t answer");
    await user.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(chooseAgent).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenCalledTimes(1);
    // Declined in the app's dialog: nothing changed, the path stays to edit.
    expect(input).toHaveValue("/x");
  });

  it("shows a chosen agent that has stopped, and Windows' own agent with nothing to change", async () => {
    desktop({
      agent: vi.fn().mockResolvedValue(
        agentSetting({
          current: {
            socket: "/Users/me/op/agent.sock",
            name: null,
            source: "chosen",
            running: false,
            keys: null,
          },
        }),
      ),
      chooseAgent: vi.fn(),
    });
    const { unmount } = renderPage();
    expect(await screen.findByText("Not running")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/op/agent.sock")).toBeInTheDocument();
    unmount();

    desktop({
      agent: vi.fn().mockResolvedValue(
        agentSetting({
          current: {
            socket: "\\\\.\\pipe\\openssh-ssh-agent",
            name: null,
            source: "windows",
            running: true,
            keys: null,
          },
          choosable: false,
        }),
      ),
      chooseAgent: vi.fn(),
    });
    renderPage();
    expect(await screen.findByText("Windows’ agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });
});
