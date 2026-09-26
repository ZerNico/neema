import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authClient,
  createDesktopTicket,
  revokeDesktopDevice,
  type DesktopSession,
} from "~/modules/auth/client.ts";
import { announceTicketRedeemed } from "~/modules/auth/ticket-events.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { describeSession, DevicesPage } from "./devices-page.tsx";

vi.mock("~/modules/auth/client.ts", () => ({
  authClient: { revokeOtherSessions: vi.fn() },
  createDesktopTicket: vi.fn(),
  revokeDesktopDevice: vi.fn(),
  desktopSessionsQuery: { queryKey: ["desktop-sessions"], queryFn: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
}));

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Electron/33 Safari/537.36 ChatDesktop/abc123";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const session = (id: string, userAgent: string, at: string, current = false): DesktopSession => ({
  id,
  userAgent,
  ipAddress: "127.0.0.1",
  createdAt: at,
  updatedAt: at,
  expiresAt: "2027-01-01T00:00:00Z",
  current,
});

const SESSIONS = [
  session("browser", CHROME_UA, "2026-09-01T10:00:00Z", true),
  session("desktop", DESKTOP_UA, "2026-09-10T10:00:00Z"),
];

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["desktop-sessions"], SESSIONS);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <DevicesPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__chatDesktop");
});

describe("describeSession", () => {
  it("names the desktop app by platform and browsers by name", () => {
    expect(describeSession(DESKTOP_UA)).toBe("neema Desktop on macOS");
    expect(describeSession(CHROME_UA)).toBe("Chrome on Windows");
    expect(describeSession("ChatDesktop/1")).toBe("neema Desktop");
    expect(describeSession(null)).toBe("Browser");
  });
});

describe("DevicesPage", () => {
  it("hides machine-local network permissions in the browser", () => {
    renderPage();
    expect(screen.queryByText("Network access")).not.toBeInTheDocument();
  });

  it("lists website hosts below desktop pairing and revokes only after confirming", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValue([{ host: "example.com" }, { host: "other.example.com" }]);
    const revoke = vi.fn().mockResolvedValue(undefined);
    Reflect.set(globalThis, "__chatDesktop", { network: { list, revoke } });
    renderPage();

    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("other.example.com")).toBeInTheDocument();
    expect(
      screen.getByText("Websites you’ve allowed Work to access from this desktop."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Devices",
      "Signed in",
      "Add a desktop",
      "Network access",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getAllByRole("button", { name: "Remove access" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove access to example.com?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(revoke).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole("button", { name: "Remove access" })[1]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove access" }),
    );
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("other.example.com"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await user.click(screen.getAllByRole("button", { name: "Remove access" })[0]!);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove access" }),
    );
    await waitFor(() => expect(revoke).toHaveBeenLastCalledWith("example.com"));
  });

  it("offers a retry when the network grant list fails", async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    Reflect.set(globalThis, "__chatDesktop", { network: { list, revoke: vi.fn() } });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load network access.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No websites allowed yet.")).toBeInTheDocument();
  });

  it("lists every session, marks this device and offers revoke only for the others", async () => {
    renderPage();

    const rows = await screen.findAllByText(/neema Desktop on macOS|Chrome on Windows/);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Chrome on Windows",
      "neema Desktop on macOS",
    ]);
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("revokes a session after confirming and refreshes the list", async () => {
    const user = userEvent.setup();
    vi.mocked(revokeDesktopDevice).mockResolvedValue({ ok: true });
    const { invalidate } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Sign out neema Desktop on macOS?");
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(revokeDesktopDevice).toHaveBeenCalledWith({ id: "desktop" }));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["desktop-sessions"] }),
    );
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(revokeDesktopDevice).not.toHaveBeenCalled();
  });

  it("signs out every other device", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.revokeOtherSessions).mockResolvedValue({ error: null } as never);
    const { invalidate } = renderPage();

    await user.click(await screen.findByRole("button", { name: "Sign out other devices" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Sign out others" }));

    await waitFor(() => expect(authClient.revokeOtherSessions).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["desktop-sessions"] }),
    );
  });

  it("generates a paste-only code and shows it with a countdown", async () => {
    const user = userEvent.setup();
    vi.mocked(createDesktopTicket).mockResolvedValue({
      ticket: "K7MX4QPD9RTA2HCVB3N5",
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Generate a code" }));

    await waitFor(() => expect(createDesktopTicket).toHaveBeenCalledWith());
    expect(await screen.findByTestId("ticket-code")).toHaveTextContent("K7MX4-QPD9R-TA2HC-VB3N5");
    expect(screen.getByRole("timer")).toHaveTextContent(/Expires in (3:00|2:5\d)/);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("swaps the code for a confirmation once that code is redeemed", async () => {
    const user = userEvent.setup();
    vi.mocked(createDesktopTicket).mockResolvedValue({
      ticket: "K7MX4QPD9RTA2HCVB3N5",
      ticketId: "t1",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Generate a code" }));
    await screen.findByTestId("ticket-code");

    act(() => announceTicketRedeemed("t1"));

    expect(await screen.findByRole("status")).toHaveTextContent("Signed in on the new device.");
    expect(screen.queryByTestId("ticket-code")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate another code" })).toBeInTheDocument();
  });
});
