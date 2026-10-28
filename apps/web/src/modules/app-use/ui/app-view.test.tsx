import type { AppUseUpdate, DesktopAppUse } from "@chat/desktop-rpc";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailPanelProvider, DetailPanelRail, type DetailPanelApi } from "~/ui/detail-panel.tsx";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";
import { AppMotionProvider } from "~/ui/motion";
import { forgetAppViews } from "../client/use-app-view.ts";
import { AppViewOwner, AppViewReturns } from "./app-view-owner.tsx";

const navigate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
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
let openChat: (() => void) | null = null;
const appUse = {
  state: vi.fn(async () => last),
  onUpdate: (listener: (update: AppUseUpdate) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  onOpenChat: (listener: () => void) => {
    openChat = listener;
    return () => {
      openChat = null;
    };
  },
  takeOpenChat: vi.fn(async (): Promise<string | null> => null),
  pause: vi.fn(async () => {}),
  place: vi.fn(async () => {}),
} satisfies DesktopAppUse;

const update = (fields: Partial<AppUseUpdate> = {}): AppUseUpdate => ({
  conversationId: "c1",
  spell: 1,
  app: "Calculator",
  label: "Clicking in Calculator",
  busy: true,
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
  forgetAppViews();
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

    await act(async () => push(update({ spell: 2, paused: true, busy: false, label: "Paused" })));
    expect(says("Paused")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]!);
    expect(appUse.pause).toHaveBeenCalledWith("c1", false);
  });

  it("stays closed once the person closes it, until the chat's next spell of app use", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 3 })));
    expect(tab()).toBeInTheDocument();
    act(() => panel.closeTab("apps:c1"));
    await act(async () => push(update({ spell: 3, busy: false })));
    expect(tab()).not.toBeInTheDocument();
    await act(async () => push(update({ spell: 4 })));
    expect(tab()).toBeInTheDocument();
  });

  it("points to the floating window while the view is there", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 7 })));
    await act(async () => push(update({ spell: 7, placement: "floating" })));
    expect(screen.getByText("Showing in a floating window")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Move to chat" })[0]!);
    expect(appUse.place).toHaveBeenCalledWith("c1", "panel");
  });

  it("takes the person back to the chat the floating window named, its tab open again", async () => {
    render(
      <>
        <AppViewReturns />
        <Harness />
      </>,
    );
    await act(async () => push(update({ spell: 9 })));
    act(() => panel.closeTab("apps:c1"));
    expect(tab()).not.toBeInTheDocument();
    appUse.takeOpenChat.mockResolvedValueOnce("c1");
    await act(async () => openChat?.());
    expect(navigate).toHaveBeenCalledWith({
      to: "/chat/$conversationId",
      params: { conversationId: "c1" },
    });
    await act(async () => push(update({ spell: 9 })));
    expect(tab()).toHaveAttribute("aria-selected", "true");
  });

  it("leaves the chat's tab unselected when the person hides the floating window", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 10, placement: "floating" })));
    expect(tab()).not.toBeInTheDocument();
    // Hidden: back in the panel's keeping, but not thrust before the person.
    await act(async () => push(update({ spell: 10, placement: "panel" })));
    expect(tab()?.getAttribute("aria-selected")).not.toBe("true");
  });

  it("brings a paused chat's tab back with Resume when the model tries again", async () => {
    render(<Harness />);
    await act(async () => push(update({ spell: 11 })));
    act(() => panel.closeTab("apps:c1"));
    await act(async () => push(update({ spell: 12, paused: true, busy: false, label: "Paused" })));
    expect(tab()).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("button", { name: "Resume" }).length).toBeGreaterThan(0);
  });
});
