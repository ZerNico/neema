import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "~/modules/notifications/server/functions.ts";
import { NotificationsPage } from "./notifications-page.tsx";

vi.mock("~/modules/notifications/server/functions.ts", () => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
  getPushKey: vi.fn(),
  subscribePush: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => "/settings/notifications",
}));

beforeEach(() => {
  vi.mocked(getNotificationPreferences).mockResolvedValue({
    push: true,
    email: false,
    emailAvailable: false,
  });
  vi.mocked(updateNotificationPreferences).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "__chatDesktop");
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationsPage />
    </QueryClientProvider>,
  );

describe("NotificationsPage", () => {
  it("chooses where schedule runs reach you, offering email only once it is set up", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("Notification", { permission: "granted" });
    renderPage();
    const channels = await screen.findByRole("button", { name: "Schedule notifications" });
    expect(channels).toHaveTextContent("Push");
    await user.click(channels);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Push" }));
    // No mail server yet, so there is no email to choose.
    expect(screen.queryByRole("menuitemcheckbox", { name: "Email" })).not.toBeInTheDocument();
    expect(updateNotificationPreferences).toHaveBeenCalledWith({ data: { push: false } });
    await waitFor(() => expect(channels).toHaveTextContent("Off"));
    // Nothing to say about this browser while it may already show them.
    expect(screen.queryByText(/in this browser/)).not.toBeInTheDocument();
  });

  it("asks this browser for permission only while push is on and it is missing", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    renderPage();
    expect(await screen.findByText("Notifications are off in this browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("never asks inside the desktop app", async () => {
    vi.stubGlobal("Notification", { permission: "default" });
    Reflect.set(globalThis, "__chatDesktop", {
      chrome: { platform: "darwin", getState: vi.fn(), onState: vi.fn(), setTheme: vi.fn() },
    });
    renderPage();
    await screen.findByRole("button", { name: "Schedule notifications" });
    expect(screen.queryByRole("button", { name: "Turn on" })).not.toBeInTheDocument();
  });
});
