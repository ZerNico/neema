import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NotificationPreferences } from "~/modules/notifications/schema.ts";
import { notificationPreferencesQuery } from "~/modules/notifications/client/queries.ts";
import { toastError } from "~/ui/error-toast.ts";
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

vi.mock("~/ui/error-toast.ts", () => ({ toastError: vi.fn() }));

let canonical: NotificationPreferences;
beforeEach(() => {
  canonical = { push: true, email: false, emailAvailable: false };
  vi.mocked(getNotificationPreferences).mockImplementation(async () => ({ ...canonical }));
  vi.mocked(updateNotificationPreferences).mockImplementation(async ({ data }) => {
    canonical = { ...canonical, ...data };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "__chatDesktop");
});

const renderPage = (
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) => {
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
  return { ...view, client };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe("NotificationsPage", () => {
  it("shows initial loading, an actionable failure, and retries to canonical preferences", async () => {
    const user = userEvent.setup();
    const initial = deferred<NotificationPreferences>();
    vi.mocked(getNotificationPreferences).mockReturnValueOnce(initial.promise);
    renderPage();
    expect(screen.getByRole("status", { name: "Loading notifications" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Schedule notifications" }),
    ).not.toBeInTheDocument();
    await act(async () => initial.reject(new Error("offline")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load notifications.");
    const retry = deferred<NotificationPreferences>();
    vi.mocked(getNotificationPreferences).mockReturnValueOnce(retry.promise);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status", { name: "Loading notifications" })).toBeInTheDocument();
    await act(async () => retry.resolve(canonical));
    expect(await screen.findByRole("button", { name: "Schedule notifications" })).toHaveTextContent(
      "Push",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains cached preferences during a background failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(notificationPreferencesQuery.queryKey, canonical);
    vi.mocked(getNotificationPreferences).mockRejectedValue(new Error("offline"));
    renderPage(client);
    await waitFor(() =>
      expect(client.getQueryState(notificationPreferencesQuery.queryKey)?.status).toBe("error"),
    );
    expect(screen.getByRole("button", { name: "Schedule notifications" })).toHaveTextContent(
      "Push",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["Push", "Email"])(
    "allows only one %s change until failure and canonical reconciliation finish",
    async (first) => {
      canonical.emailAvailable = true;
      const user = userEvent.setup();
      const pending = deferred<void>();
      const reconcile = deferred<NotificationPreferences>();
      vi.mocked(updateNotificationPreferences).mockReturnValueOnce(pending.promise);
      const { client } = renderPage();
      const channels = await screen.findByRole("button", { name: "Schedule notifications" });
      await user.click(channels);
      const item = await screen.findByRole("menuitemcheckbox", { name: first });
      await user.click(item);
      await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledOnce());
      expect(channels).toBeDisabled();
      fireEvent.click(item);
      expect(updateNotificationPreferences).toHaveBeenCalledOnce();
      vi.mocked(getNotificationPreferences).mockReturnValueOnce(reconcile.promise);
      await act(async () => pending.reject(new Error("rejected")));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(channels).toBeDisabled();
      // Canonical state can include a change from another tab, rather than our rollback snapshot.
      canonical = { push: true, email: true, emailAvailable: true };
      await act(async () => reconcile.resolve(canonical));
      await waitFor(() => expect(channels).toBeEnabled());
      expect(channels).toHaveTextContent("Push, Email");
      expect(client.getQueryData(notificationPreferencesQuery.queryKey)).toEqual(canonical);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(channels).toHaveAttribute("aria-expanded", "false"));
      await user.click(channels);
      await user.click(
        await screen.findByRole("menuitemcheckbox", { name: first === "Push" ? "Email" : "Push" }),
      );
      await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(channels).toBeEnabled());
      expect(channels).toHaveTextContent(first === "Push" ? "Push" : "Email");
    },
  );

  it.each(["success", "failure"])(
    "keeps remounted controls locked through %s and canonical reconciliation",
    async (outcome) => {
      canonical.emailAvailable = true;
      const user = userEvent.setup();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
      });
      client.setQueryData(notificationPreferencesQuery.queryKey, canonical);
      const pending = deferred<void>();
      const reconcile = deferred<NotificationPreferences>();
      vi.mocked(updateNotificationPreferences).mockReturnValueOnce(pending.promise);
      const first = renderPage(client);
      await user.click(screen.getByRole("button", { name: "Schedule notifications" }));
      await user.click(await screen.findByRole("menuitemcheckbox", { name: "Push" }));
      await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledOnce());
      first.unmount();
      const returned = renderPage(client);
      const channels = screen.getByRole("button", { name: "Schedule notifications" });
      expect(channels).toHaveTextContent("Off");
      expect(channels).toBeDisabled();
      expect(channels).toHaveAttribute("aria-busy", "true");
      fireEvent.click(channels);
      expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
      expect(updateNotificationPreferences).toHaveBeenCalledOnce();

      vi.mocked(getNotificationPreferences).mockReturnValueOnce(reconcile.promise);
      await act(async () => {
        if (outcome === "success") pending.resolve(undefined);
        else pending.reject(new Error("rejected"));
      });
      await waitFor(() => expect(getNotificationPreferences).toHaveBeenCalledOnce());
      expect(channels).toBeDisabled();
      returned.unmount();
      renderPage(client);
      const reconciledChannels = screen.getByRole("button", { name: "Schedule notifications" });
      expect(reconciledChannels).toBeDisabled();
      canonical = { push: false, email: true, emailAvailable: true };
      await act(async () => reconcile.resolve(canonical));
      await waitFor(() => expect(reconciledChannels).toBeEnabled());
      expect(reconciledChannels).toHaveTextContent("Email");
      expect(client.getQueryData(notificationPreferencesQuery.queryKey)).toEqual(canonical);
      await user.click(reconciledChannels);
      await user.click(await screen.findByRole("menuitemcheckbox", { name: "Push" }));
      await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(reconciledChannels).toBeEnabled());
      expect(reconciledChannels).toHaveTextContent("Push, Email");
    },
  );

  it("rejects a second activation before pending state reaches the menu", async () => {
    canonical.emailAvailable = true;
    const user = userEvent.setup();
    const pending = deferred<void>();
    vi.mocked(updateNotificationPreferences).mockReturnValueOnce(pending.promise);
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Schedule notifications" }));
    const push = await screen.findByRole("menuitemcheckbox", { name: "Push" });
    const email = screen.getByRole("menuitemcheckbox", { name: "Email" });
    act(() => {
      fireEvent.click(push);
      fireEvent.click(email);
    });
    await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledOnce());
    expect(updateNotificationPreferences).toHaveBeenCalledWith({ data: { push: false } });
    canonical.push = false;
    await act(async () => pending.resolve(undefined));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Schedule notifications" })).toBeEnabled(),
    );
  });

  it("does not carry pending writes or old rollback across QueryClient identities", async () => {
    canonical.emailAvailable = true;
    const user = userEvent.setup();
    const pending = deferred<void>();
    vi.mocked(updateNotificationPreferences).mockReturnValueOnce(pending.promise);
    const first = renderPage();
    await user.click(await screen.findByRole("button", { name: "Schedule notifications" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Push" }));
    await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledOnce());
    first.unmount();
    const second = renderPage();
    const channels = await screen.findByRole("button", { name: "Schedule notifications" });
    expect(channels).toBeEnabled();
    await user.click(channels);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Email" }));
    await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(channels).toBeEnabled());
    expect(channels).toHaveTextContent("Push, Email");
    const secondPreferences = second.client.getQueryData(notificationPreferencesQuery.queryKey);
    await act(async () => pending.reject(new Error("old identity rejected")));
    await waitFor(() => expect(first.client.isMutating()).toBe(0));
    expect(second.client.getQueryData(notificationPreferencesQuery.queryKey)).toEqual(
      secondPreferences,
    );
    expect(channels).toHaveTextContent("Push, Email");
    expect(updateNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  it("cancels a stale in-flight preference fetch before applying a change", async () => {
    canonical.emailAvailable = true;
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(notificationPreferencesQuery.queryKey, canonical);
    const oldFetch = deferred<NotificationPreferences>();
    const pending = deferred<void>();
    vi.mocked(getNotificationPreferences).mockReturnValueOnce(oldFetch.promise);
    vi.mocked(updateNotificationPreferences).mockReturnValueOnce(pending.promise);
    renderPage(client);
    await waitFor(() => expect(getNotificationPreferences).toHaveBeenCalledOnce());
    const channels = screen.getByRole("button", { name: "Schedule notifications" });
    await user.click(channels);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Email" }));
    await waitFor(() => expect(updateNotificationPreferences).toHaveBeenCalledOnce());
    await act(async () => oldFetch.resolve({ push: false, email: false, emailAvailable: true }));
    expect(client.getQueryData(notificationPreferencesQuery.queryKey)).toEqual({
      push: true,
      email: true,
      emailAvailable: true,
    });
    canonical.email = true;
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(channels).toBeEnabled());
    expect(channels).toHaveTextContent("Push, Email");
  });
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
