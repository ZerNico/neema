import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BrowserFavicon, BrowserOpenTab, DesktopBrowser } from "@chat/desktop-rpc";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppMotionProvider } from "~/ui/motion";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  type DetailPanelApi,
} from "~/ui/detail-panel.tsx";
import { browserTabs } from "../client/browser-store.ts";
import { BrowserHost } from "./browser-host.tsx";
import { BROWSER_TAB_PREFIX, browserNewTab } from "./browser-request.tsx";
import { BrowserPanelOwner } from "./browser-tab.tsx";
import { useBrowserChat } from "../client/use-browser-chat.ts";

const route = vi.hoisted(() => ({
  pathname: "/chat/c1",
  conversationId: "c1" as string | undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: { pathname: route.pathname },
      matches: [
        {
          pathname: route.pathname,
          params: route.conversationId ? { conversationId: route.conversationId } : {},
        },
      ],
    }),
}));

let openTab: ((event: BrowserOpenTab) => void) | null = null;
let favicon: ((event: BrowserFavicon) => void) | null = null;
const desktop = {
  partition: "persist:browser-0123456789abcdef",
  temporaryPartition: (id: string) => `browser-temp-0123456789abcdef-${id}`,
  setLifecycle: vi.fn(async () => {}),
  onOpenTab: (listener: (event: BrowserOpenTab) => void) => {
    openTab = listener;
    return () => {
      openTab = null;
    };
  },
  onFavicon: (listener: (event: BrowserFavicon) => void) => {
    favicon = listener;
    return () => {
      favicon = null;
    };
  },
  openExternal: vi.fn(async () => {}),
} satisfies DesktopBrowser;

let panel: DetailPanelApi;
const queryClient = new QueryClient();
function Probe() {
  const api = useDetailPanel();
  useEffect(() => {
    panel = api;
  }, [api]);
  return null;
}

function TemporaryChat() {
  useBrowserChat("c1", true);
  return null;
}

function Harness({ children, temporary = false }: { children?: ReactNode; temporary?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppMotionProvider>
        <DetailPanelProvider newTab={browserNewTab}>
          <Probe />
          <BrowserHost />
          <BrowserPanelOwner />
          {temporary ? <TemporaryChat /> : null}
          {children}
          <DetailPanelRail />
        </DetailPanelProvider>
      </AppMotionProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("__chatDesktop", { browser: desktop });
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  route.pathname = "/chat/c1";
  route.conversationId = "c1";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const id of browserTabs.all().keys()) browserTabs.remove(id);
  browserTabs.setTemporary("c1", false);
});

const webviews = () => [...document.querySelectorAll("webview")];
const strip = () => screen.getByRole("tab", { name: "a.test" });

describe("browser tabs", () => {
  it("turns a new tab into a page from its address bar", () => {
    render(<Harness />);
    act(() => panel.newTab());
    fireEvent.change(screen.getByPlaceholderText("Search or enter an address"), {
      target: { value: "example.com" },
    });
    fireEvent.submit(screen.getByPlaceholderText("Search or enter an address"));
    const [tab] = [...browserTabs.all().values()];
    expect(tab).toMatchObject({ url: "https://example.com/", partition: desktop.partition });
    expect(screen.getByRole("tab", { name: "example.com" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("tab", { name: "New tab" })).not.toBeInTheDocument();
    const [webview] = webviews();
    expect(webview).toHaveAttribute("src", "https://example.com/");
    expect(webview).toHaveAttribute("partition", desktop.partition);
    expect(webview).toHaveAttribute("allowpopups", "true");
  });

  it("browses a temporary chat in its in-memory profile and keeps nothing", () => {
    render(<Harness temporary />);
    act(() => panel.newTab());
    fireEvent.change(screen.getByPlaceholderText("Search or enter an address"), {
      target: { value: "https://a.test" },
    });
    fireEvent.submit(screen.getByPlaceholderText("Search or enter an address"));
    const [tab] = [...browserTabs.all().values()];
    expect(tab?.partition).toBe(desktop.temporaryPartition("c1"));
  });

  it("restores a stored tab discarded, and closing the tab ends its page", () => {
    render(<Harness />);
    act(() =>
      panel.open({
        id: `${BROWSER_TAB_PREFIX}kept`,
        title: "Kept",
        body: null,
        restorable: true,
        data: { url: "https://kept.test/" },
      }),
    );
    expect(browserTabs.get("kept")).toMatchObject({
      url: "https://kept.test/",
      owner: "c1",
    });
    act(() => panel.closeTab(`${BROWSER_TAB_PREFIX}kept`));
    expect(browserTabs.get("kept")).toBeNull();
    expect(webviews()).toHaveLength(0);
  });

  it("tells the shell how a hidden page should run, only when that changes", () => {
    const hidden = browserTabs.open({
      owner: "c2",
      partition: desktop.partition,
      url: "https://elsewhere.test/",
    });
    render(<Harness />);
    act(() => browserTabs.update(hidden.id, { webContentsId: 7 }));
    expect(desktop.setLifecycle).toHaveBeenCalledWith(7, "background");
    act(() => browserTabs.update(hidden.id, { title: "Elsewhere" }));
    expect(desktop.setLifecycle).toHaveBeenCalledTimes(1);
    // An answer of that chat running here keeps its page fully alive.
    act(() => browserTabs.setHeld(new Set(["c2"])));
    expect(desktop.setLifecycle).toHaveBeenLastCalledWith(7, "active");
    act(() => browserTabs.setHeld(new Set()));
    expect(desktop.setLifecycle).toHaveBeenCalledTimes(3);
  });

  it("shows a hovered link's address over the page, as a browser does", () => {
    render(<Harness />);
    act(() => panel.newTab());
    fireEvent.change(screen.getByPlaceholderText("Search or enter an address"), {
      target: { value: "https://a.test" },
    });
    fireEvent.submit(screen.getByPlaceholderText("Search or enter an address"));
    const [webview] = webviews();
    act(() => {
      webview!.dispatchEvent(
        Object.assign(new Event("update-target-url"), { url: "https://b.test/x" }),
      );
    });
    expect(screen.getByText("https://b.test/x")).toBeInTheDocument();
    act(() => {
      webview!.dispatchEvent(Object.assign(new Event("update-target-url"), { url: "" }));
    });
    expect(screen.queryByText("https://b.test/x")).not.toBeInTheDocument();
  });

  it("puts a steady working note in place of the address row while an answer uses the tab", () => {
    render(<Harness />);
    act(() => panel.newTab());
    fireEvent.change(screen.getByPlaceholderText("Search or enter an address"), {
      target: { value: "https://a.test" },
    });
    fireEvent.submit(screen.getByPlaceholderText("Search or enter an address"));
    const [tab] = [...browserTabs.all().values()];
    act(() => browserTabs.update(tab!.id, { usedBy: { messageId: "m1", generationId: "g1" } }));
    expect(screen.getByRole("status")).toHaveTextContent("Working on a.test");
    // Framed over the page, since the page paints over its own element's edges.
    expect(document.querySelector(".border-primary.fixed")).not.toBeNull();
    expect(screen.queryByPlaceholderText("Search or enter an address")).not.toBeInTheDocument();
    act(() => browserTabs.update(tab!.id, { usedBy: null }));
    expect(screen.getByPlaceholderText("Search or enter an address")).toBeInTheDocument();
    expect(document.querySelector(".border-primary.fixed")).toBeNull();
  });

  it("opens a web link clicked in the conversation as a panel tab, and ⌘ asks for the browser", () => {
    render(
      <Harness>
        <div data-web-links="panel">
          <a href="https://linked.test/page" target="_blank" rel="noreferrer">
            Linked
          </a>
        </div>
        <a href="https://elsewhere.test/" target="_blank" rel="noreferrer">
          Settings link
        </a>
      </Harness>,
    );
    fireEvent.click(screen.getByText("Linked"));
    expect([...browserTabs.all().values()].map((tab) => tab.url)).toEqual([
      "https://linked.test/page",
    ]);
    expect(screen.getByRole("tab", { name: "linked.test" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // A modifier asks for the other place; links outside the conversation are not touched.
    fireEvent.click(screen.getByText("Linked"), { metaKey: true });
    fireEvent.click(screen.getByText("Settings link"));
    expect(browserTabs.all().size).toBe(1);
  });

  it("keeps another chat's pages when this chat's tabs change", () => {
    const elsewhere = browserTabs.open({
      owner: "c2",
      partition: desktop.partition,
      url: "https://elsewhere.test/",
    });
    render(<Harness />);
    act(() => panel.newTab());
    expect(browserTabs.get(elsewhere.id)).not.toBeNull();
    expect(webviews()).toHaveLength(1);
  });

  it("opens a popup from a page on screen as a tab, and anything else outside", () => {
    render(<Harness />);
    const source = browserTabs.open({
      owner: "c1",
      partition: desktop.partition,
      url: "https://a.test/",
    });
    act(() => browserTabs.update(source.id, { webContentsId: 7 }));
    act(() => openTab?.({ webContentsId: 7, url: "https://popup.test/" }));
    expect(screen.getByRole("tab", { name: "popup.test" })).toBeInTheDocument();
    act(() => openTab?.({ webContentsId: 99, url: "https://unknown.test/" }));
    expect(desktop.openExternal).toHaveBeenCalledWith("https://unknown.test/");
  });

  it("closes browser tabs outside the desktop app, where nothing can show them", () => {
    vi.stubGlobal("__chatDesktop", undefined);
    render(<Harness />);
    act(() =>
      panel.open({
        id: `${BROWSER_TAB_PREFIX}kept`,
        title: "Kept",
        body: null,
        restorable: true,
        data: { url: "https://kept.test/" },
      }),
    );
    expect(screen.queryByRole("tab", { name: "Kept" })).not.toBeInTheDocument();
    expect(webviews()).toHaveLength(0);
  });

  it("gives a new tab the same address bar a page has, with nothing to go back to", () => {
    render(<Harness />);
    act(() => panel.newTab());
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("");
    for (const name of ["Back", "Forward", "Reload", "Open in browser"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("shows a page's favicon in its tab, and a spinner while it loads", () => {
    render(<Harness />);
    const tab = browserTabs.open({
      owner: "c1",
      partition: desktop.partition,
      url: "https://a.test/",
    });
    act(() => panel.open({ id: `${BROWSER_TAB_PREFIX}${tab.id}`, title: "a.test", body: null }));
    act(() => browserTabs.update(tab.id, { webContentsId: 7, loading: true }));
    expect(strip().querySelector("[data-slot=spinner]")).not.toBeNull();
    act(() => browserTabs.update(tab.id, { loading: false }));
    act(() => favicon?.({ webContentsId: 7, dataUrl: "data:image/png;base64,AQID" }));
    // Loading settles a moment after it stops, so the spinner holds meanwhile.
    expect(strip().querySelector("[data-slot=spinner]")).not.toBeNull();
    return vi.waitFor(() =>
      expect(strip().querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AQID"),
    );
  });

  it("browses on a page that is not a chat, owned by that page", () => {
    route.pathname = "/projects/p1";
    route.conversationId = undefined;
    render(<Harness />);
    act(() => panel.newTab());
    fireEvent.change(screen.getByPlaceholderText("Search or enter an address"), {
      target: { value: "example.com" },
    });
    fireEvent.submit(screen.getByPlaceholderText("Search or enter an address"));
    const [tab] = [...browserTabs.all().values()];
    expect(tab).toMatchObject({ owner: "page:/projects/p1", partition: desktop.partition });
  });
});
