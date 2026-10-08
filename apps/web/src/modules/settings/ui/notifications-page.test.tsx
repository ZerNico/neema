import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNotificationPreferences,
  listPushDevices,
} from "~/modules/notifications/server/functions.ts";
import { NotificationsPage } from "./notifications-page.tsx";

vi.mock("~/modules/notifications/server/functions.ts", () => ({
  getNotificationPreferences: vi.fn(),
  setEmailNotifications: vi.fn(),
  getPushKey: vi.fn(),
  listPushDevices: vi.fn(),
  removePushDevice: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => "/settings/notifications",
}));

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

beforeEach(() => {
  vi.mocked(getNotificationPreferences).mockResolvedValue({ email: false, available: false });
});

describe("NotificationsPage", () => {
  it("offers turning on notifications here, and explains why closed ones are unavailable", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    vi.mocked(listPushDevices).mockResolvedValue([
      {
        id: "d",
        label: "Firefox on Linux",
        createdAt: new Date().toISOString(),
        lastDeliveredAt: null,
      },
    ]);
    renderPage();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
    // jsdom is not a secure context.
    expect(screen.getByText("Needs neema on an https address.")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Notify this browser when neema is closed" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText("Firefox on Linux")).toBeInTheDocument();
    expect(await screen.findByText("An administrator hasn’t set up email.")).toBeInTheDocument();
  });

  it("in the desktop app, speaks of the app and offers no push", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.mocked(listPushDevices).mockResolvedValue([]);
    Reflect.set(globalThis, "__chatDesktop", {
      chrome: {
        platform: "darwin",
        getState: vi.fn(),
        onState: vi.fn(),
        setTheme: vi.fn(),
      },
    });
    renderPage();
    expect(screen.getByRole("heading", { name: "This app" })).toBeInTheDocument();
    expect(
      screen.getByText("On while the app is running, even with its window closed."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Notify this browser when neema is closed" }),
    ).not.toBeInTheDocument();
  });
});
