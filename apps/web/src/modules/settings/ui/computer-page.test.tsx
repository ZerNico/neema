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
      localAllowed: vi.fn().mockResolvedValue(false),
      revokeLocal: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    Reflect.set(globalThis, "__chatDesktop", { network });
    return network;
  };

  it("lists destinations with their ports and removes one only after confirming", async () => {
    const user = userEvent.setup();
    const ssh = { host: "github.com", port: 22, privateNetwork: false };
    const internal = { host: "git.internal", port: 443, privateNetwork: true };
    const network = desktop({ list: vi.fn().mockResolvedValue([ssh, internal]) });
    renderPage();

    expect(await screen.findByText("github.com:22")).toBeInTheDocument();
    expect(screen.getByText("git.internal:443 (private network)")).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "This computer",
      "Where commands can connect",
      "Local network services",
      "What commands can read",
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

  it("shows local services allowed for every chat and stops allowing them", async () => {
    const user = userEvent.setup();
    const network = desktop({ localAllowed: vi.fn().mockResolvedValue(true) });
    renderPage();
    expect(await screen.findByText("Allowed for every chat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(network.revokeLocal).toHaveBeenCalledTimes(1));
  });

  it("shows loading, failure and an empty list as rows of the same card", async () => {
    const user = userEvent.setup();
    desktop({ list: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]) });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this list.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByText("Nothing yet.")).toHaveLength(2);
    expect(screen.getByText("Asked in each chat.")).toBeInTheDocument();
  });
});
