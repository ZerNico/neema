import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopChrome } from "@chat/desktop-rpc";
import { DesktopChromeProvider } from "./desktop-chrome.tsx";
import { HistoryButtons } from "./history-buttons.tsx";

const chrome: DesktopChrome = {
  platform: "darwin",
  getState: async () => ({ fullscreen: false }),
  onState: () => () => {},
  setTheme: async () => {},
};

async function renderApp() {
  const root = createRootRoute({
    component: () => (
      <DesktopChromeProvider>
        <HistoryButtons />
        <Outlet />
      </DesktopChromeProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <main>{path}</main> });
  const router = createRouter({
    routeTree: root.addChildren([page("/"), page("/a"), page("/b")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("main");
  return router;
}

const back = () => screen.getByRole("button", { name: "Back" });
const forward = () => screen.getByRole("button", { name: "Forward" });

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.desktopChrome;
});

it("renders nothing outside the desktop shell", async () => {
  await renderApp();
  expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
});

it("enables each direction only when there is somewhere to go", async () => {
  vi.stubGlobal("__chatDesktop", { chrome });
  const router = await renderApp();
  expect(back()).toBeDisabled();
  expect(forward()).toBeDisabled();

  await act(async () => router.history.push("/a"));
  await act(async () => router.history.push("/b"));
  expect(back()).toBeEnabled();
  expect(forward()).toBeDisabled();

  await act(async () => fireEvent.click(back()));
  expect(await screen.findByText("/a")).toBeInTheDocument();
  expect(forward()).toBeEnabled();

  await act(async () => fireEvent.keyDown(window, { key: "[", metaKey: true }));
  expect(await screen.findByText("/")).toBeInTheDocument();
  expect(back()).toBeDisabled();

  await act(async () => fireEvent.keyDown(window, { key: "]", metaKey: true }));
  expect(await screen.findByText("/a")).toBeInTheDocument();
  expect(forward()).toBeEnabled();

  // A new navigation drops the entries ahead, as the real history does.
  await act(async () => router.history.push("/"));
  expect(forward()).toBeDisabled();
  expect(back()).toBeEnabled();
});
