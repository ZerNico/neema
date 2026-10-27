import type { AppUseUpdate, DesktopAppUse } from "@chat/desktop-rpc";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPanelProvider, DetailPanelRail, type DetailPanelApi } from "~/ui/detail-panel.tsx";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import { AppMotionProvider } from "~/ui/motion";
import { AppViewOwner } from "./app-view-owner.tsx";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: { pathname: "/chat/c1" },
      matches: [{ pathname: "/chat/c1", params: { conversationId: "c1" } }],
    }),
}));

const listeners = new Set<(update: AppUseUpdate) => void>();
// As main does: the chat's view as last told, for a part of the page that listens late.
let last: AppUseUpdate | null = null;
const push = (update: AppUseUpdate) => {
  last = update;
  for (const listener of listeners) listener(update);
};
const appUse = {
  state: vi.fn(async () => last),
  onUpdate: (listener: (update: AppUseUpdate) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  onOpenChat: () => () => {},
  pause: vi.fn(async () => {}),
  place: vi.fn(async () => {}),
} satisfies DesktopAppUse;

const update = (fields: Partial<AppUseUpdate> = {}): AppUseUpdate => ({
  conversationId: "c1",
  spell: 1,
  app: "Calculator",
  call: { name: "app_click", args: { app: "Calculator", ref: "e7" } },
  live: true,
  paused: false,
  placement: "panel",
  frame: { data: "", width: 230, height: 408 },
  click: { x: 0.5, y: 0.5, at: 1 },
  ...fields,
});

let panel: DetailPanelApi;
function Probe() {
  const api = useDetailPanel();
  useEffect(() => {
    panel = api;
  }, [api]);
  return null;
}

function Harness({ stop }: { stop?: () => void }) {
  return (
    <AppMotionProvider>
      <DetailPanelProvider>
        <Probe />
        <AppViewOwner conversationId="c1" stop={stop} />
        <DetailPanelRail />
      </DetailPanelProvider>
    </AppMotionProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal("__chatDesktop", { appUse });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  last = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const tab = () => screen.queryByRole("tab", { name: "Calculator" });
/** The bar's line; the tab strip's spinner is a status too. */
const says = (text: string) =>
  screen.getAllByRole("status").some((status) => status.textContent?.includes(text));

describe("the live view of app use", () => {
  it("opens on the chat's panel, named after the app, and says what it does", async () => {
    render(<Harness />);
    await act(async () => push(update()));
    expect(tab()).toHaveAttribute("aria-selected", "true");
    expect(says("Clicking in Calculator")).toBe(true);
    expect(screen.getByRole("img", { name: "Live view of Calculator" })).toBeInTheDocument();
  });

  it("pauses the chat's app use, stops the answer and floats from the bar", async () => {
    const stop = vi.fn();
    render(<Harness stop={stop} />);
    await act(async () => push(update({ spell: 2 })));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(appUse.pause).toHaveBeenCalledWith("c1", true);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move to floating window" }));
    expect(appUse.place).toHaveBeenCalledWith("c1", "floating");

    await act(async () => push(update({ spell: 2, paused: true, call: null })));
    expect(says("Paused")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]!);
    expect(appUse.pause).toHaveBeenCalledWith("c1", false);
  });

  it("stays closed once the person closes it, until the chat's next spell of app use", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 3 })));
    expect(tab()).toBeInTheDocument();
    act(() => panel.closeTab("apps:c1"));
    await act(async () => push(update({ spell: 3, call: null })));
    expect(tab()).not.toBeInTheDocument();
    await act(async () => push(update({ spell: 4 })));
    expect(tab()).toBeInTheDocument();
  });

  it("points to the floating window while the view is there", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 5 })));
    await act(async () => push(update({ spell: 5, placement: "floating" })));
    expect(screen.getByText("Showing in a floating window")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Move to chat" })[0]!);
    expect(appUse.place).toHaveBeenCalledWith("c1", "panel");
  });
});
