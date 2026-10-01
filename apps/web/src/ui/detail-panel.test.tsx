import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionIdentity } from "~/modules/auth/server/functions.ts";
import { AppMotionProvider } from "~/ui/motion";
import { defaultDetailPanelWidth } from "./detail-panel-width.ts";
import {
  DetailPanelProvider,
  DetailPanelRail,
  DetailPanelToggle,
  PanelToggleSpace,
  useDetailPanel,
  useDetailPanelReconciler,
  useDetailPanelSelectedId,
  type DetailPanelApi,
} from "./detail-panel.tsx";

const environment = vi.hoisted(() => ({
  mobile: false,
  pathname: "/chat/one",
  reducedMotion: true,
  holdMotion: false,
  panelOff: false,
}));
const animations = vi.hoisted(
  () =>
    [] as {
      target: string;
      complete: NonNullable<
        ComponentProps<typeof import("motion/react-m").aside>["onAnimationComplete"]
      >;
    }[],
);
vi.mock("motion/react-m", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react-m")>();
  return {
    ...actual,
    aside: ({ onAnimationComplete, ...props }: ComponentProps<typeof actual.aside>) => {
      if (onAnimationComplete && typeof props.animate === "string") {
        animations.push({ target: props.animate, complete: onAnimationComplete });
      }
      return (
        <actual.aside
          {...props}
          {...(!environment.holdMotion && onAnimationComplete ? { onAnimationComplete } : {})}
        />
      );
    },
  };
});
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: { pathname: environment.pathname },
      matches: [
        {
          pathname: environment.pathname,
          staticData: environment.panelOff ? { detailPanel: false } : {},
        },
      ],
    }),
}));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => environment.mobile }));
vi.mock("~/modules/auth/server/functions.ts", () => ({ getSessionIdentity: vi.fn() }));
vi.mock("~/modules/auth/client.ts", () => ({
  authClient: {
    $store: {
      atoms: {
        $sessionSignal: { listen: () => () => {} },
        session: { listen: () => () => {} },
      },
    },
  },
}));

// Nobody has dragged the rail yet in these tests, so it opens at its share of the window.
const initialWidth = defaultDetailPanelWidth(window.innerWidth);
const initial = `${initialWidth}px`;

let panel: DetailPanelApi;
function Probe() {
  const api = useDetailPanel();
  useEffect(() => {
    panel = api;
  }, [api]);
  return null;
}

function StatefulBody({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <>
      <p>{label}</p>
      <button onClick={() => setCount((value) => value + 1)}>Count: {count}</button>
    </>
  );
}

const selectionRender = vi.fn();
function SelectionProbe() {
  selectionRender(useDetailPanelSelectedId());
  return null;
}

function Harness({ userId, children }: { userId?: string; children?: ReactNode }) {
  return (
    <StrictMode>
      <AppMotionProvider>
        <DetailPanelProvider {...(userId ? { userId } : {})}>
          <Probe />
          <SelectionProbe />
          {children}
          <main tabIndex={-1}>
            <button>Open details</button>
            <button>Elsewhere</button>
            <DetailPanelToggle />
          </main>
          <DetailPanelRail className="test-panel-class" />
        </DetailPanelProvider>
      </AppMotionProvider>
    </StrictMode>
  );
}

// jsdom implements pointer events without pointer capture, which the resize
// handle uses so a drag survives leaving the 6px handle.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

const preferenceListeners = new Set<() => void>();
beforeEach(() => {
  // The rail width is a real preference, so it outlives a render; reset it or
  // one test's drag becomes the next test's starting width.
  window.localStorage.clear();
  environment.mobile = false;
  environment.pathname = "/chat/one";
  environment.reducedMotion = true;
  environment.holdMotion = false;
  environment.panelOff = false;
  animations.length = 0;
  selectionRender.mockClear();
  preferenceListeners.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return environment.reducedMotion;
      },
      addEventListener: (_event: string, listener: () => void) => preferenceListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        preferenceListeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastExit() {
  for (let index = animations.length - 1; index >= 0; index--) {
    const exit = animations[index]!;
    if (exit.target.startsWith("closed-")) return exit;
  }
  throw new Error("Expected a desktop exit animation");
}

describe.each([false, true])("detail panel (mobile=%s)", (mobile) => {
  it("truncates a long title in its tab", () => {
    environment.mobile = mobile;
    render(<Harness />);
    const title = "LongDocumentTitle".repeat(15);
    act(() => panel.open({ id: "long", title, body: <p>Document</p> }));
    expect(within(screen.getByRole("tab")).getByText(title)).toHaveClass("truncate");
  });

  it("refreshes same-ID props without resetting body state; a different ID resets it", () => {
    environment.mobile = mobile;
    environment.reducedMotion = false;
    render(<Harness />);
    act(() =>
      panel.open({
        id: "one",
        title: "Details",
        body: <StatefulBody label="Original" />,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
    const counter = screen.getByRole("button", { name: "Count: 1" });
    counter.focus();
    const scroller = counter.parentElement!;
    scroller.scrollTop = 120;
    const animationTarget = animations.at(-1)?.target;

    act(() =>
      panel.refresh({
        id: "one",
        title: "Updated details",
        subtitle: "New subtitle",
        body: <StatefulBody label="Updated" />,
      }),
    );
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("New subtitle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Count: 1" })).toBe(counter);
    expect(counter).toHaveFocus();
    expect(scroller.scrollTop).toBe(120);
    expect(animations.at(-1)?.target).toBe(animationTarget);

    act(() =>
      panel.open({ id: "two", title: "Other details", body: <StatefulBody label="Other body" /> }),
    );
    expect(screen.getByRole("button", { name: "Count: 0" })).not.toBe(counter);
    expect(screen.getByText("Other body")).toBeInTheDocument();
  });

  it("rejects late refresh/close after switching panels, and never reopens a closed panel", () => {
    environment.mobile = mobile;
    render(<Harness />);
    const original = { id: "one", title: "Details", body: <p>Original</p> };
    const late = { ...original, body: <p>Late progress</p> };
    act(() => panel.open(original));
    act(() => {
      panel.open({ id: "sources", title: "Sources", body: <p>Source snapshot</p> });
      panel.refresh(late);
      panel.closeTab("one");
    });
    expect(screen.getByText("Source snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Late progress")).not.toBeInTheDocument();
    act(() => panel.closeTab("sources"));
    expect(screen.queryByText("Source snapshot")).not.toBeInTheDocument();
    act(() => panel.refresh(late));
    expect(screen.queryByText("Late progress")).not.toBeInTheDocument();
    act(() => {
      panel.open(original);
      panel.hide();
      panel.refresh(late);
    });
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    expect(screen.queryByText("Late progress")).not.toBeInTheDocument();
  });

  it("keeps actions stable and does not notify selected-ID subscribers on refresh", () => {
    environment.mobile = mobile;
    render(<Harness />);
    const api = panel;
    act(() => panel.open({ id: "one", title: "Details", body: <p>Original</p> }));
    expect(selectionRender).toHaveBeenLastCalledWith("one");
    selectionRender.mockClear();
    act(() => panel.refresh({ id: "one", title: "Details", body: <p>Progress</p> }));
    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(selectionRender).not.toHaveBeenCalled();
    expect(panel).toBe(api);
    act(() => panel.hide());
    expect(selectionRender).toHaveBeenLastCalledWith(null);
  });

  it("drops non-restorable tabs on navigation and hides on request", () => {
    environment.mobile = mobile;
    const view = render(<Harness />);
    const original = { id: "one", title: "Details", body: <p>Panel content</p> };
    act(() => panel.open(original));
    environment.pathname = "/chat/two";
    view.rerender(<Harness />);
    expect(screen.queryByText("Panel content")).not.toBeInTheDocument();
    act(() => panel.refresh(original));
    expect(screen.queryByText("Panel content")).not.toBeInTheDocument();
    act(() => panel.open({ id: "two", title: "Details", body: <p>Other content</p> }));
    act(() => panel.hide());
    expect(screen.queryByText("Other content")).not.toBeInTheDocument();
  });
});

it("resizes the desktop rail by drag and keyboard, within limits, and remembers it", async () => {
  const { unmount } = render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
  const rail = screen.getByRole("complementary");
  const handle = screen.getByRole("separator", { name: "Resize panel" });
  const width = async (expected: string) => waitFor(() => expect(rail.style.width).toBe(expected));
  await width(initial);

  // The rail is on the right, so dragging its edge left widens it.
  fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
  // Embedded pages stop taking the pointer for the drag's duration.
  expect(document.documentElement).toHaveAttribute("data-panel-resizing");
  fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
  await width(`${initialWidth + 100}px`);
  fireEvent.pointerUp(handle, { clientX: 700, pointerId: 1 });
  expect(document.documentElement).not.toHaveAttribute("data-panel-resizing");

  // Half the window is the ceiling, so the conversation keeps its share, and
  // the floor keeps the header and a line of Markdown readable.
  fireEvent.pointerDown(handle, { button: 0, clientX: 700, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: -4000, pointerId: 1 });
  await width(`${Math.round(window.innerWidth / 2)}px`);
  fireEvent.pointerMove(handle, { clientX: 4000, pointerId: 1 });
  await width("320px");
  fireEvent.pointerUp(handle, { clientX: 4000, pointerId: 1 });

  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  await width("344px");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  await width("320px");

  // Kept across a remount, and a double click puts it back.
  unmount();
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
  const reopened = screen.getByRole("complementary");
  await waitFor(() => expect(reopened.style.width).toBe("320px"));
  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize panel" }));
  await waitFor(() => expect(reopened.style.width).toBe(initial));
});

it("hides the desktop rail on Escape", () => {
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
});

it("deselects immediately, retains only inert presentation, then cleans up on desktop completion", async () => {
  environment.reducedMotion = false;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <StatefulBody label="Outgoing" /> }));
  const rail = screen.getByRole("complementary");
  expect(rail).toHaveClass("test-panel-class", "overflow-hidden");
  expect((rail.lastElementChild as HTMLElement).style.width).toBe(initial);
  act(() => panel.hide());
  expect(selectionRender).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(rail).toHaveAttribute("aria-hidden", "true");
  expect(rail).toHaveAttribute("inert");
  expect(rail).toHaveClass("pointer-events-none");
  expect(screen.getByText("Outgoing")).toBeInTheDocument();
  act(() => panel.refresh({ id: "one", title: "Late", body: <p>Late data</p> }));
  expect(screen.queryByText("Late data")).not.toBeInTheDocument();
  await waitFor(() => expect(rail).not.toBeInTheDocument());
});

it.each(["one", "two"])("ignores an old desktop exit after rapid reopen of %s", (id) => {
  environment.reducedMotion = false;
  environment.holdMotion = true;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <StatefulBody label="Original" /> }));
  fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
  const shell = screen.getByRole("complementary");
  act(() => panel.hide());
  const oldExit = lastExit();
  act(() => panel.open({ id, title: "New details", body: <StatefulBody label="Reopened" /> }));
  expect(screen.getByRole("complementary")).toBe(shell);
  expect(shell).not.toHaveAttribute("inert");
  expect(
    screen.getByRole("button", { name: id === "one" ? "Count: 1" : "Count: 0" }),
  ).toBeInTheDocument();
  act(() => oldExit.complete(oldExit.target));
  expect(screen.getByText("Reopened")).toBeInTheDocument();
  act(() => panel.hide());
  const newExit = lastExit();
  expect(newExit.target).not.toBe(oldExit.target);
  act(() => oldExit.complete(oldExit.target));
  expect(screen.getByText("Reopened")).toBeInTheDocument();
  act(() => newExit.complete(newExit.target));
  expect(screen.queryByText("Reopened")).not.toBeInTheDocument();
});

it("switches identities in the existing expanded desktop shell", async () => {
  environment.reducedMotion = false;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>First body</p> }));
  const rail = screen.getByRole("complementary");
  await waitFor(() => expect(rail.style.width).toBe(initial));
  act(() => panel.open({ id: "two", title: "Sources", body: <p>Second body</p> }));
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe(initial);
  expect(screen.queryByText("First body")).not.toBeInTheDocument();
  expect(screen.getByText("Second body")).toBeInTheDocument();
});

it("purges an exiting desktop body on navigation without restoring its opener", () => {
  environment.reducedMotion = false;
  environment.holdMotion = true;
  const view = render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open details" });
  opener.focus();
  act(() => panel.open({ id: "one", title: "Details", body: <StatefulBody label="Old route" /> }));
  const focus = vi.spyOn(opener, "focus");
  screen.getByRole("button", { name: "Count: 0" }).focus();
  environment.pathname = "/chat/two";
  view.rerender(<Harness />);
  expect(screen.queryByText("Old route")).not.toBeInTheDocument();
  expect(focus).not.toHaveBeenCalled();
  act(() => panel.open({ id: "two", title: "Details", body: <p>Exiting route</p> }));
  act(() => panel.hide());
  const oldExit = lastExit();
  environment.pathname = "/chat/three";
  view.rerender(<Harness />);
  expect(screen.queryByText("Exiting route")).not.toBeInTheDocument();
  act(() => panel.open({ id: "three", title: "Details", body: <p>New route</p> }));
  act(() => oldExit.complete(oldExit.target));
  expect(screen.getByText("New route")).toBeInTheDocument();
});

it("cleans up immediately when reduced motion becomes preferred during an exit", () => {
  environment.reducedMotion = false;
  environment.holdMotion = true;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Outgoing</p> }));
  act(() => panel.hide());
  expect(screen.getByText("Outgoing")).toBeInTheDocument();
  act(() => {
    environment.reducedMotion = true;
    preferenceListeners.forEach((notify) => notify());
  });
  expect(screen.queryByText("Outgoing")).not.toBeInTheDocument();
});

it("cleans up without a completion event when animation frames are unavailable", () => {
  environment.reducedMotion = false;
  environment.holdMotion = true;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>No animation body</p> }));
  vi.stubGlobal("requestAnimationFrame", undefined);
  act(() => panel.hide());
  expect(screen.queryByText("No animation body")).not.toBeInTheDocument();
});

it("opens at full width and removes closed content synchronously with reduced motion", () => {
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Reduced body</p> }));
  expect(screen.getByRole("complementary").style.width).toBe(initial);
  act(() => panel.hide());
  expect(screen.queryByText("Reduced body")).not.toBeInTheDocument();
});

it.each(["close", "escape", "switch"])(
  "restores the desktop opener before removing focused content on %s",
  (action) => {
    environment.reducedMotion = false;
    environment.holdMotion = true;
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open details" });
    opener.focus();
    act(() =>
      panel.open({ id: "one", title: "Details", body: <StatefulBody label="Focused body" /> }),
    );
    const rail = screen.getByRole("complementary");
    screen.getByRole("button", { name: "Count: 0" }).focus();
    const focus = vi.spyOn(opener, "focus").mockImplementation(() => {
      expect(rail).not.toHaveAttribute("inert");
      HTMLElement.prototype.focus.call(opener);
    });
    if (action === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (action === "switch")
      act(() => panel.open({ id: "two", title: "Sources", body: <p>New body</p> }));
    else fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(focus).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  },
);

it("uses main when a virtualized opener has disappeared and never steals outside focus", () => {
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open details" });
  opener.focus();
  const request = { id: "one", title: "Details", body: <StatefulBody label="Focused body" /> };
  act(() => panel.open(request));
  opener.remove();
  screen.getByRole("button", { name: "Count: 0" }).focus();
  act(() => panel.hide());
  expect(screen.getByRole("main")).toHaveFocus();
  act(() => panel.open(request));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  act(() => panel.hide());
  expect(elsewhere).toHaveFocus();
});

it("covers the page on a phone, and swaps hosts across the breakpoint", () => {
  environment.mobile = true;
  const view = render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel body</p> }));
  const overlay = screen.getByRole("complementary");
  expect(overlay).toHaveClass("absolute", "inset-x-0");
  expect(screen.queryByRole("separator", { name: "Resize panel" })).not.toBeInTheDocument();
  environment.mobile = false;
  view.rerender(<Harness />);
  const rail = screen.getByRole("complementary");
  expect(rail).not.toBe(overlay);
  expect(rail).not.toHaveClass("absolute");
  expect(screen.getByRole("separator", { name: "Resize panel" })).toBeInTheDocument();
  expect(screen.getByText("Panel body")).toBeInTheDocument();
});

it("survives an identity revalidation on tab return without replaying its open animation", async () => {
  // A live tab is never blanked while the session is rechecked: hiding the tree
  // detaches host refs, which Motion reads as a remount and answers by running
  // `initial` again, so the rail collapsed to 0 and slid open on every refocus.
  environment.reducedMotion = false;
  const { IdentityBoundary } = await import("~/modules/auth/identity-boundary.tsx");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const identity = { userId: "user", impersonatedBy: null };
  let release!: (value: typeof identity) => void;
  vi.mocked(getSessionIdentity).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IdentityBoundary identity={identity}>
        <Harness />
      </IdentityBoundary>
    </QueryClientProvider>,
  );
  act(() => release(identity));
  act(() => panel.open({ id: "one", title: "Details", body: <StatefulBody label="Live" /> }));
  const rail = screen.getByRole("complementary");
  await waitFor(() => expect(rail.style.width).toBe(initial));
  fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
  const counter = screen.getByRole("button", { name: "Count: 1" });
  const openTarget = animations.at(-1)?.target;

  fireEvent(document, new Event("visibilitychange"));
  fireEvent.focus(window);
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe(initial);
  expect(rail).toBeVisible();
  await act(async () => release(identity));
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe(initial);
  expect(screen.getByRole("button", { name: "Count: 1" })).toBe(counter);
  expect(animations.at(-1)?.target).toBe(openTarget);

  // A real close/reopen still animates: the fix removed the false remount, not the motion.
  act(() => panel.hide());
  expect(lastExit().target).toMatch(/^closed-/);
});

function Reconcile({ live }: { live: string[] }) {
  useDetailPanelReconciler("doc:", live);
  return null;
}

const selected = () => screen.getByRole("tab", { selected: true });
const space = () => screen.getByTestId("header").firstElementChild;
const order = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

// dnd-kit marks a pointerdown it accepts with its sensor; jsdom has no layout,
// so the drag itself cannot run here. The setup's PointerEvent stand-in is
// used because dnd-kit checks the event's type.
function press(target: Element) {
  const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "isPrimary", { value: true });
  target.dispatchEvent(event);
  return (event as PointerEvent & { sensor?: unknown }).sensor;
}

describe("tabs", () => {
  it("adds a tab per id and mounts only the selected body", () => {
    render(<Harness />);
    act(() => panel.open({ id: "one", title: "First", body: <StatefulBody label="First body" /> }));
    act(() => panel.open({ id: "two", title: "Second", body: <p>Second body</p> }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["First", "Second"]);
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second body");
    expect(screen.queryByText("First body")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "First" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("First body");
    expect(screen.queryByText("Second body")).not.toBeInTheDocument();
  });

  it("opens beside the selected tab, and closing one selects its neighbour", () => {
    render(<Harness />);
    for (const id of ["a", "b", "c"]) act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    act(() => panel.select("a"));
    act(() => panel.open({ id: "d", title: "d", body: <p>d</p> }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["a", "d", "b", "c"]);
    fireEvent.click(screen.getByRole("button", { name: "Close d" }));
    expect(screen.getByRole("tab", { name: "b" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close c" }));
    fireEvent.click(screen.getByRole("button", { name: "Close b" }));
    expect(screen.getByRole("tab", { name: "a" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close a" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(selectionRender).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Show panel" })).toBeInTheDocument();
  });

  it("reserves header room for the toggle only while the toggle is over the header", () => {
    render(
      <Harness>
        <header data-testid="header">
          <PanelToggleSpace inHeader />
        </header>
      </Harness>,
    );
    expect(space()).not.toHaveAttribute("data-collapsed");
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    // Collapsed rather than removed, so the header closes the gap smoothly.
    expect(space()).toHaveAttribute("data-collapsed");
    environment.mobile = true;
    act(() => panel.hide());
    act(() => panel.show());
    expect(space()).not.toHaveAttribute("data-collapsed");
  });

  it("opens on a new tab from the toggle, which stays the one switch", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
    expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Nothing open here yet");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.getAllByRole("tab", { name: "New tab" })).toHaveLength(2);
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("First body");
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show panel (3 tabs)" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    render(<Harness />);
    for (const id of ["a", "b", "c"]) act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    fireEvent.keyDown(selected(), { key: "ArrowRight" });
    expect(selected()).toHaveTextContent("a");
    expect(selected()).toHaveFocus();
    fireEvent.keyDown(selected(), { key: "End" });
    expect(selected()).toHaveTextContent("c");
    fireEvent.keyDown(selected(), { key: "ArrowLeft" });
    expect(selected()).toHaveTextContent("b");
    fireEvent.keyDown(selected(), { key: "Home" });
    expect(selected()).toHaveTextContent("a");
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([selected()]);
  });

  it("lets a press on a tab start a drag, but not a press on its close button", () => {
    render(<Harness />);
    act(() => panel.open({ id: "a", title: "a", body: <p>a</p> }));
    expect(press(within(screen.getByRole("tab", { name: "a" })).getByText("a"))).toBeDefined();
    expect(press(screen.getByRole("button", { name: "Close a" }))).toBeUndefined();
  });

  it("leaves no-drag to one box over the strip, so tabs scrolled out never block the header", () => {
    render(<Harness />);
    for (const id of ["a", "b"]) act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    const list = screen.getByRole("tablist");
    const hit = list.parentElement!.querySelector("[data-tab-strip-hit]");
    // A sibling after the list, sized by the list's visible box, never an ancestor of a tab.
    expect(hit?.parentElement).toBe(list.parentElement);
    expect(list.contains(hit)).toBe(false);
    expect(hit).toHaveClass("pointer-events-none");
  });

  it("adds a new tab last, wherever the selected tab is", () => {
    render(<Harness />);
    for (const id of ["a", "b"]) act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    act(() => panel.select("a"));
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(order()).toEqual(["a", "b", "New tab"]);
  });

  it("moves the focused tab with Alt+Shift+arrows, keeping it selected", () => {
    render(<Harness />);
    for (const id of ["a", "b", "c"]) act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    const c = screen.getByRole("tab", { name: "c" });
    fireEvent.keyDown(c, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(order()).toEqual(["a", "c", "b"]);
    fireEvent.keyDown(c, { key: "ArrowLeft", altKey: true, shiftKey: true });
    fireEvent.keyDown(c, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(order()).toEqual(["c", "a", "b"]);
    expect(c).toHaveAttribute("aria-selected", "true");
  });

  it("switches tabs without replaying the panel's entrance", () => {
    environment.reducedMotion = false;
    render(<Harness />);
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    act(() => panel.open({ id: "two", title: "Second", body: <p>Second body</p> }));
    const container = screen.getByRole("tabpanel").parentElement;
    fireEvent.click(screen.getByRole("tab", { name: "First" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("First body");
    expect(screen.getByRole("tabpanel").parentElement).toBe(container);
  });

  it("keeps its tabs when hidden, and the header toggle brings them back", () => {
    render(<Harness />);
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    act(() => panel.open({ id: "two", title: "Second", body: <p>Second body</p> }));
    fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show panel (2 tabs)" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second body");
    expect(screen.queryByRole("button", { name: /Show panel/ })).not.toBeInTheDocument();
  });

  it("refreshes an unselected tab without selecting it", () => {
    render(<Harness />);
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    act(() => panel.open({ id: "two", title: "Second", body: <p>Second body</p> }));
    act(() => panel.refresh({ id: "one", title: "Renamed", body: <p>Renamed body</p> }));
    expect(screen.getByRole("tab", { name: "Renamed" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Second body");
  });

  it("keeps a released restorable tab pending and closes any other", () => {
    render(<Harness />);
    act(() => panel.open({ id: "doc", title: "Doc", body: <p>Doc body</p>, restorable: true }));
    act(() => panel.release("doc"));
    expect(screen.getByRole("tab", { name: "Doc" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("Doc body")).not.toBeInTheDocument();
    act(() => panel.open({ id: "snapshot", title: "Snapshot", body: <p>Snapshot body</p> }));
    act(() => panel.release("snapshot"));
    expect(screen.queryByRole("tab", { name: "Snapshot" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Doc" })).toHaveAttribute("aria-selected", "true");
  });

  it("restores a page's restorable tabs across navigation and restarts, per account", () => {
    const view = render(<Harness userId="u1" />);
    act(() => panel.open({ id: "doc", title: "Doc", body: <p>Doc body</p>, restorable: true }));
    act(() => panel.open({ id: "snapshot", title: "Snapshot", body: <p>Snapshot body</p> }));
    environment.pathname = "/chat/two";
    view.rerender(<Harness userId="u1" />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    environment.pathname = "/chat/one";
    view.rerender(<Harness userId="u1" />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Doc"]);
    // The body was never stored: its owner rebuilds it from the id.
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    act(() =>
      panel.refresh({ id: "doc", title: "Doc", body: <p>Rebuilt body</p>, restorable: true }),
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Rebuilt body");

    view.unmount();
    const restarted = render(<Harness userId="u1" />);
    expect(screen.getByRole("tab", { name: "Doc" })).toHaveAttribute("aria-selected", "true");
    restarted.unmount();
    render(<Harness userId="u2" />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("never opens a restored panel by itself on a phone", () => {
    const first = render(<Harness userId="u1" />);
    act(() => panel.open({ id: "doc", title: "Doc", body: <p>Doc body</p>, restorable: true }));
    first.unmount();
    environment.mobile = true;
    render(<Harness userId="u1" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
    expect(screen.getByRole("complementary", { name: "Doc" })).toBeInTheDocument();
  });

  it("closes a kind's tabs once the page proves their item gone", () => {
    const view = render(<Harness />);
    for (const id of ["doc:a", "doc:b", "other:x"])
      act(() => panel.open({ id, title: id, body: <p>{id}</p> }));
    view.rerender(
      <Harness>
        <Reconcile live={["a"]} />
      </Harness>,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["doc:a", "other:x"]);
  });

  it("is simply there on arriving at a page with it open; only opening slides it in", () => {
    environment.reducedMotion = false;
    const view = render(<Harness userId="u1" />);
    act(() => panel.open({ id: "doc", title: "Doc", body: <p>Doc body</p>, restorable: true }));
    environment.pathname = "/chat/two";
    view.rerender(<Harness userId="u1" />);
    environment.pathname = "/chat/one";
    view.rerender(<Harness userId="u1" />);
    // Restored open: mounted at full width, with no slide from zero.
    expect(screen.getByRole("complementary").style.width).toBe(initial);
    act(() => panel.hide());
    act(() => lastExit().complete(lastExit().target));
    act(() => panel.show());
    expect(screen.getByRole("complementary").style.width).toBe("0px");
  });

  it("stays off a page that opts out, toggle and header room included", () => {
    environment.panelOff = true;
    render(
      <Harness>
        <header data-testid="header">
          <PanelToggleSpace inHeader />
        </header>
      </Harness>,
    );
    act(() => panel.open({ id: "one", title: "First", body: <p>First body</p> }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /panel/ })).not.toBeInTheDocument();
    expect(space()).toHaveAttribute("data-collapsed");
  });
});
