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

  it("lists the websites Work can connect to and removes one only after confirming", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValue([{ host: "example.com" }, { host: "other.example.com" }]);
    const revoke = vi.fn().mockResolvedValue(undefined);
    Reflect.set(globalThis, "__chatDesktop", { network: { list, revoke } });
    renderPage();

    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "This computer",
      "Websites Work can connect to",
    ]);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove example.com?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(revoke).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("other.example.com"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("shows loading, failure and an empty list as rows of the same card", async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    Reflect.set(globalThis, "__chatDesktop", { network: { list, revoke: vi.fn() } });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load this list.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No websites yet.")).toBeInTheDocument();
  });
});
