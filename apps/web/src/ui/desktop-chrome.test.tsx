import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ClientOnly } from "@tanstack/react-router";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { runInNewContext } from "node:vm";
import userEvent from "@testing-library/user-event";
import { createContext, useContext, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type DesktopChrome, type DesktopChromeState } from "@chat/desktop-rpc";
import { SidebarProvider, SidebarTrigger, useSidebar } from "./primitives/sidebar";
import {
  AppHeader,
  DesktopChromeFrame,
  DesktopChromeProvider,
  desktopChromeInitScript,
} from "./desktop-chrome.tsx";
import { setTheme } from "./theme.tsx";

const stateListeners = new Set<(state: DesktopChromeState) => void>();
const chrome: DesktopChrome = {
  platform: "darwin",
  getState: vi.fn(async () => ({ fullscreen: false })),
  onState: (listener) => {
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  },
  setTheme: vi.fn(async () => {}),
};
const Context = createContext("outside");
const mounted = vi.fn();
const unmounted = vi.fn();

function Controls() {
  const value = useContext(Context);
  const sidebar = useSidebar();
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounted();
    return () => {
      unmounted();
    };
  }, []);
  return (
    <>
      <SidebarTrigger />
      <button onClick={() => setCount((current) => current + 1)}>
        {value}: {count}
      </button>
      <span>Sidebar {sidebar.state}</span>
    </>
  );
}

function App({ path = "Chat" }: { path?: string }) {
  return (
    <DesktopChromeProvider>
      <SidebarProvider>
        <Context value="inside">
          <AppHeader>
            <Controls />
          </AppHeader>
          <main>{path}</main>
        </Context>
      </SidebarProvider>
    </DesktopChromeProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  render(<DesktopChromeFrame />);
  stateListeners.clear();
  vi.mocked(chrome.getState).mockResolvedValue({ fullscreen: false });
  localStorage.clear();
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
  delete document.documentElement.dataset.desktopFullscreen;
  localStorage.clear();
});

it.each([
  undefined,
  {
    protocolVersion: PROTOCOL_VERSION,
    request: () => {},
    stageDroppedFile: async () => null,
  },
])("keeps the original header without a chrome capability (%s)", (channel) => {
  vi.stubGlobal("__chatDesktop", channel);
  render(<App />);
  expect(screen.getByRole("banner").parentElement).toHaveAttribute("data-slot", "sidebar-wrapper");
  expect(document.querySelector(".desktop-titlebar-content")).toBeEmptyDOMElement();
  expect(document.documentElement).not.toHaveAttribute("data-desktop-chrome");
  expect(chrome.setTheme).not.toHaveBeenCalled();
});

it("portals one header without losing context or remounting controls on route/fullscreen changes", async () => {
  vi.stubGlobal("__chatDesktop", { chrome });
  const view = render(<App />);
  await waitFor(() => expect(document.documentElement.dataset.desktopFullscreen).toBe("false"));
  expect(screen.getAllByRole("banner")).toHaveLength(1);
  expect(screen.getByRole("banner").closest(".desktop-titlebar")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "inside: 0" }));
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  expect(screen.getByText("Sidebar collapsed")).toBeInTheDocument();
  act(() => {
    for (const listener of stateListeners) listener({ fullscreen: true });
  });
  view.rerender(<App path="Settings" />);
  expect(screen.getByText("Settings")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "inside: 1" })).toBeInTheDocument();
  expect(document.documentElement.dataset.desktopFullscreen).toBe("true");
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  act(() => {
    for (const listener of stateListeners) listener({ fullscreen: false });
  });
  expect(document.documentElement.dataset.desktopFullscreen).toBe("false");
  view.unmount();
  expect(unmounted).toHaveBeenCalledTimes(1);
  expect(stateListeners.size).toBe(0);
  expect(document.documentElement).toHaveAttribute("data-desktop-chrome", "darwin");
});

it("does not overwrite a fullscreen event with a stale attachment snapshot", async () => {
  let resolve!: (state: DesktopChromeState) => void;
  vi.mocked(chrome.getState).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  vi.stubGlobal("__chatDesktop", { chrome });
  const view = render(
    <DesktopChromeProvider>
      <main>Sign in</main>
    </DesktopChromeProvider>,
  );
  expect(document.querySelector(".desktop-titlebar")).not.toBeNull();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  await act(async () => {
    for (const listener of stateListeners) listener({ fullscreen: true });
    resolve({ fullscreen: false });
  });
  expect(document.documentElement.dataset.desktopFullscreen).toBe("true");
  view.unmount();
});

it("synchronizes stored and changed theme preferences including returning to system", async () => {
  localStorage.setItem("theme", "dark");
  vi.stubGlobal("__chatDesktop", { chrome });
  render(
    <DesktopChromeProvider>
      <main>Sign in</main>
    </DesktopChromeProvider>,
  );
  expect(chrome.setTheme).toHaveBeenLastCalledWith("dark");
  act(() => setTheme("light"));
  expect(chrome.setTheme).toHaveBeenLastCalledWith("light");
  act(() => setTheme("system"));
  expect(chrome.setTheme).toHaveBeenLastCalledWith("system");
});

it("hydrates a generic shell into the desktop header without replacing its frame", async () => {
  cleanup();
  vi.stubGlobal("__chatDesktop", { chrome });
  localStorage.setItem("theme", "dark");
  const shell = (
    <>
      <DesktopChromeFrame />
      <ClientOnly fallback={<p>Loading Chat…</p>}>
        <App />
      </ClientOnly>
    </>
  );
  const container = document.createElement("div");
  container.innerHTML = renderToString(shell);
  document.body.append(container);
  const frame = container.querySelector(".desktop-titlebar");
  const target = container.querySelector(".desktop-titlebar-content");
  expect(container.textContent).toBe("Loading Chat…");
  expect(chrome.getState).not.toHaveBeenCalled();
  expect(chrome.setTheme).not.toHaveBeenCalled();
  const errors = vi.fn();
  const root = hydrateRoot(container, shell, { onRecoverableError: errors });
  try {
    await waitFor(() => expect(screen.getByRole("banner").parentElement).toBe(target));
    expect(container.querySelector(".desktop-titlebar")).toBe(frame);
    expect(container.querySelectorAll("header")).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(chrome.setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reserves first-paint space only for a complete supported capability", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    vi.stubGlobal("__chatDesktop", { chrome: { ...chrome, platform } });
    runInNewContext(desktopChromeInitScript, { window, document });
    expect(document.documentElement.dataset.desktopChrome).toBe(platform);
    delete document.documentElement.dataset.desktopChrome;
  }
  vi.stubGlobal("__chatDesktop", { chrome: { platform: "darwin" } });
  runInNewContext(desktopChromeInitScript, { window, document });
  expect(document.documentElement).not.toHaveAttribute("data-desktop-chrome");
});
