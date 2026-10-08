import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { redeemDesktopTicket } from "~/modules/auth/client.ts";
import { toast } from "sonner";
import { challengeOf, UNBOUND_TICKET } from "~/modules/auth/desktop-ticket.ts";
import { identityNavigation } from "~/modules/auth/identity-context.ts";
import { DesktopSignIn } from "./desktop-sign-in.tsx";

vi.mock("~/modules/auth/client.ts", () => ({ redeemDesktopTicket: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const redeem = vi.mocked(redeemDesktopTicket);
const TICKET = "K7MX4QPD9RTA2HCVB3N5";

const renderPage = (canChangeServer = true) => {
  const listeners = new Set<(ticket: string) => void>();
  const changeServer = vi.fn(async () => {});
  const auth = {
    onTicket: (listener: (ticket: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canChangeServer,
    changeServer,
  };
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const clear = vi.spyOn(client, "clear");
  render(
    <QueryClientProvider client={client}>
      <DesktopSignIn auth={auth} />
    </QueryClientProvider>,
  );
  return { listeners, clear, changeServer };
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.spyOn(identityNavigation, "replace").mockImplementation(() => {});
});

describe("DesktopSignIn", () => {
  it("links to the browser page with the challenge of a verifier that survives a reload", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Sign in in your browser" });
    const verifier = sessionStorage.getItem("chat.desktop-verifier");
    expect(verifier).toBeTruthy();
    const challenge = await challengeOf(verifier!);
    expect(link).toHaveAttribute(
      "href",
      `${window.location.origin}/desktop/sign-in?challenge=${challenge}`,
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("redeems a pasted code with the verifier, clears the cache and replaces the document", async () => {
    const user = userEvent.setup();
    redeem.mockResolvedValue({ ok: true });
    const { clear } = renderPage();
    const verifier = sessionStorage.getItem("chat.desktop-verifier");

    await user.type(screen.getByLabelText("Code"), "k7mx4-qpd9r ta2hc vb3n5");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(redeem).toHaveBeenCalledWith({ ticket: TICKET, verifier }));
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/"));
    expect(clear).toHaveBeenCalled();
    expect(sessionStorage.getItem("chat.desktop-verifier")).toBeNull();
  });

  it("shows the server's message inline when the code is refused", async () => {
    const user = userEvent.setup();
    redeem.mockRejectedValue(new Error("That code is not valid."));
    renderPage();

    await user.type(screen.getByLabelText("Code"), "K7MX4-QPD9R-TA2HC-VB3N5{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not valid.");
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("chat.desktop-verifier")).toBeTruthy();
  });

  it("refuses a half-typed code without calling the server", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Code"), "K7MX4{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the whole code from your browser.",
    );
    expect(redeem).not.toHaveBeenCalled();
  });

  it("asks the shell for its server chooser and shows a refusal", async () => {
    const user = userEvent.setup();
    const { changeServer } = renderPage();
    await user.click(screen.getByRole("button", { name: "Not your server? Change server" }));
    await waitFor(() => expect(changeServer).toHaveBeenCalledOnce());
    expect(redeem).not.toHaveBeenCalled();
    changeServer.mockRejectedValueOnce(new Error("The server is fixed by CHAT_DESKTOP_SERVER."));
    await user.click(screen.getByRole("button", { name: "Not your server? Change server" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The server is fixed by CHAT_DESKTOP_SERVER."),
    );
  });

  it("offers no server switch while the shell pins its server", async () => {
    renderPage(false);
    await screen.findByRole("link", { name: "Sign in in your browser" });
    expect(screen.queryByRole("button", { name: /Change server/ })).not.toBeInTheDocument();
  });

  it("signs in from a deep link at once when the code is bound to this shell", async () => {
    redeem.mockResolvedValue({ ok: true });
    const { listeners } = renderPage();
    await waitFor(() => expect(listeners.size).toBe(1));

    act(() => {
      for (const listener of listeners) listener(TICKET);
    });

    expect(screen.getByLabelText("Code")).toHaveValue("K7MX4-QPD9R-TA2HC-VB3N5");
    await waitFor(() =>
      expect(redeem).toHaveBeenCalledWith({
        ticket: TICKET,
        verifier: expect.any(String),
        boundOnly: true,
      }),
    );
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/"));
  });

  it("waits for Continue when a deep-linked code was not asked for by this shell", async () => {
    // The server refuses it unused: anyone can open the link with their own code.
    redeem.mockRejectedValueOnce(new Error(UNBOUND_TICKET)).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { listeners } = renderPage();
    await waitFor(() => expect(listeners.size).toBe(1));

    act(() => {
      for (const listener of listeners) listener(TICKET);
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus());
    expect(identityNavigation.replace).not.toHaveBeenCalled();
    // Not an error, only unconfirmed.
    expect(screen.queryByText(UNBOUND_TICKET)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(redeem).toHaveBeenLastCalledWith({ ticket: TICKET, verifier: expect.any(String) }),
    );
    await waitFor(() => expect(identityNavigation.replace).toHaveBeenCalledWith("/"));
  });
});
