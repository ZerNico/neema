import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authClient, createDesktopTicket } from "~/modules/auth/client.ts";
import { announceTicketRedeemed } from "~/modules/auth/ticket-events.ts";
import { DesktopSignInPage } from "./desktop-sign-in-page.tsx";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("~/modules/auth/client.ts", () => ({
  authClient: { signOut: vi.fn() },
  createDesktopTicket: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));

const mint = vi.mocked(createDesktopTicket);
const signOut = vi.mocked(authClient.signOut);
const USER = { name: "Nico", email: "nico@example.com", image: null };
const TICKET = "K7MX4QPD9RTA2HCVB3N5";

const renderPage = (challenge?: string) => {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const clear = vi.spyOn(client, "clear");
  render(
    <QueryClientProvider client={client}>
      <DesktopSignInPage user={USER} challenge={challenge} />
    </QueryClientProvider>,
  );
  return { clear };
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DesktopSignInPage", () => {
  it("mints a ticket with the challenge and shows it formatted with the deep link", async () => {
    const user = userEvent.setup();
    mint.mockResolvedValue({
      ticket: TICKET,
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage("abc");

    expect(screen.getByText("nico@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));

    await waitFor(() => expect(mint).toHaveBeenCalledWith({ challenge: "abc" }));
    expect(await screen.findByTestId("ticket-code")).toHaveTextContent("K7MX4-QPD9R-TA2HC-VB3N5");
    expect(screen.getByRole("link", { name: "Open neema Desktop" })).toHaveAttribute(
      "href",
      `chat-desktop://sign-in?ticket=${TICKET}`,
    );
    expect(screen.getByRole("timer")).toHaveTextContent(/Expires in (3:00|2:5\d)/);
    expect(screen.getByText("You can close this tab afterwards.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use a different account" }),
    ).not.toBeInTheDocument();
  });

  it("mints a paste-only ticket when no challenge was given", async () => {
    const user = userEvent.setup();
    mint.mockResolvedValue({
      ticket: TICKET,
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage();

    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));

    await waitFor(() => expect(mint).toHaveBeenCalledWith({}));
  });

  it("copies the formatted code", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mint.mockResolvedValue({
      ticket: TICKET,
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage("abc");

    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));
    await user.click(await screen.findByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("K7MX4-QPD9R-TA2HC-VB3N5");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("offers a new code once the countdown reaches zero", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mint.mockResolvedValue({
      ticket: TICKET,
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    });
    renderPage("abc");

    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));
    await screen.findByTestId("ticket-code");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByText("This code has expired.")).toBeInTheDocument();
    mint.mockResolvedValue({
      ticket: "ABCDEFGHJKMNPQRSTVWX",
      ticketId: "t2",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    await user.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(await screen.findByTestId("ticket-code")).toHaveTextContent("ABCDE-FGHJK-MNPQR-STVWX");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("reports the sign-in the moment its own ticket is redeemed and offers another", async () => {
    const user = userEvent.setup();
    mint.mockResolvedValue({
      ticket: TICKET,
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage("abc");
    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));
    await screen.findByTestId("ticket-code");

    // Someone else's ticket leaves this code alone.
    act(() => announceTicketRedeemed("other"));
    expect(screen.getByTestId("ticket-code")).toBeInTheDocument();

    act(() => announceTicketRedeemed("t1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Signed in on the new device.");
    expect(screen.queryByTestId("ticket-code")).not.toBeInTheDocument();

    mint.mockResolvedValue({
      ticket: "ABCDEFGHJKMNPQRSTVWX",
      ticketId: "t2",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    await user.click(screen.getByRole("button", { name: "Generate another code" }));
    expect(await screen.findByTestId("ticket-code")).toHaveTextContent("ABCDE-FGHJK-MNPQR-STVWX");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the refusal inline and keeps the continue button", async () => {
    const user = userEvent.setup();
    mint.mockRejectedValue(new Error("Your account is waiting for approval."));
    renderPage("abc");

    await user.click(screen.getByRole("button", { name: "Continue as Nico" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your account is waiting for approval.",
    );
    expect(screen.getByRole("button", { name: "Continue as Nico" })).toBeEnabled();
  });

  it("signs out, clears the cache and returns to login with the redirect", async () => {
    const user = userEvent.setup();
    signOut.mockResolvedValue({} as never);
    const { clear } = renderPage("abc");

    await user.click(screen.getByRole("button", { name: "Use a different account" }));

    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(clear).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/login",
      search: { redirect: "/desktop/sign-in?challenge=abc" },
    });
  });
});
