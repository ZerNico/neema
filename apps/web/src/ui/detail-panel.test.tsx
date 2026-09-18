import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionIdentity } from "~/modules/auth/server/functions.ts";
import { AppMotionProvider } from "~/ui/motion";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  useDetailPanelSelectedId,
  type DetailPanelApi,
} from "./detail-panel.tsx";

const environment = vi.hoisted(() => ({
  mobile: false,
  pathname: "/chat/one",
  reducedMotion: true,
  holdMotion: false,
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
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => environment.pathname }));
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

function Harness() {
  return (
    <StrictMode>
      <AppMotionProvider>
        <DetailPanelProvider>
          <Probe />
          <SelectionProbe />
          <main tabIndex={-1}>
            <button>Open details</button>
            <button>Elsewhere</button>
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
  window.localStorage.removeItem("chat.detail-panel-width");
  environment.mobile = false;
  environment.pathname = "/chat/one";
  environment.reducedMotion = true;
  environment.holdMotion = false;
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

function deferredAnimation() {
  let resolve!: () => void;
  const promise = new Promise<Animation>((done) => {
    resolve = () => done({} as Animation);
  });
  return { promise, resolve };
}

function lastExit() {
  for (let index = animations.length - 1; index >= 0; index--) {
    const exit = animations[index]!;
    if (exit.target.startsWith("closed-")) return exit;
  }
  throw new Error("Expected a desktop exit animation");
}

describe.each([false, true])("detail panel (mobile=%s)", (mobile) => {
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
      panel.closeIfSelected("one");
    });
    expect(screen.getByText("Source snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Late progress")).not.toBeInTheDocument();
    act(() => panel.closeIfSelected("sources"));
    expect(screen.queryByText("Source snapshot")).not.toBeInTheDocument();
    act(() => panel.refresh(late));
    expect(screen.queryByText("Late progress")).not.toBeInTheDocument();
    act(() => {
      panel.open(original);
      panel.close();
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
    act(() => panel.close());
    expect(selectionRender).toHaveBeenLastCalledWith(null);
  });

  it("still closes on navigation and explicit close", () => {
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
    act(() => panel.close());
    expect(screen.queryByText("Other content")).not.toBeInTheDocument();
  });
});

it("resizes the desktop rail by drag and keyboard, within limits, and remembers it", async () => {
  const { unmount } = render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
  const rail = screen.getByRole("complementary");
  const handle = screen.getByRole("separator", { name: "Resize panel" });
  const width = async (expected: string) =>
    waitFor(() => expect(rail.style.width).toBe(expected));
  await width("352px");

  // The rail is on the right, so dragging its edge left widens it.
  fireEvent.pointerDown(handle, { button: 0, clientX: 800, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 });
  await width("452px");
  fireEvent.pointerUp(handle, { clientX: 700, pointerId: 1 });

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
  await waitFor(() => expect(reopened.style.width).toBe("352px"));
});

it("closes the desktop rail on Escape", () => {
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
  expect((rail.firstElementChild as HTMLElement).style.width).toBe("352px");
  act(() => panel.close());
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
  act(() => panel.close());
  const oldExit = lastExit();
  act(() => panel.open({ id, title: "New details", body: <StatefulBody label="Reopened" /> }));
  expect(screen.getByRole("complementary")).toBe(shell);
  expect(shell).not.toHaveAttribute("inert");
  expect(
    screen.getByRole("button", { name: id === "one" ? "Count: 1" : "Count: 0" }),
  ).toBeInTheDocument();
  act(() => oldExit.complete(oldExit.target));
  expect(screen.getByText("Reopened")).toBeInTheDocument();
  act(() => panel.close());
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
  await waitFor(() => expect(rail.style.width).toBe("352px"));
  act(() => panel.open({ id: "two", title: "Sources", body: <p>Second body</p> }));
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe("352px");
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
  act(() => panel.close());
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
  act(() => panel.close());
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
  act(() => panel.close());
  expect(screen.queryByText("No animation body")).not.toBeInTheDocument();
});

it("opens at full width and removes closed content synchronously with reduced motion", () => {
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Reduced body</p> }));
  expect(screen.getByRole("complementary").style.width).toBe("352px");
  act(() => panel.close());
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
    else fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
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
  act(() => panel.close());
  expect(screen.getByRole("main")).toHaveFocus();
  act(() => panel.open(request));
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  act(() => panel.close());
  expect(elsewhere).toHaveFocus();
});

it("retains the native mobile Sheet until its own CSS exit completes", async () => {
  environment.mobile = true;
  environment.reducedMotion = false;
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open details" });
  opener.focus();
  act(() => panel.open({ id: "one", title: "Details", body: <p>Mobile outgoing</p> }));
  const sheet = screen.getByRole("dialog");
  const finished = deferredAnimation();
  sheet.getAnimations = vi.fn(() => [{ finished: finished.promise } as Animation]);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(selectionRender).toHaveBeenLastCalledWith(null);
  expect(sheet).toBeInTheDocument();
  expect(sheet).toHaveAttribute("data-ending-style");
  expect(sheet).toHaveAttribute("inert");
  expect(sheet).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByText("Mobile outgoing")).toBeInTheDocument();
  await waitFor(() => expect(sheet.getAnimations).toHaveBeenCalled());
  await act(async () => finished.resolve());
  await waitFor(() => expect(sheet).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  act(() => panel.refresh({ id: "one", title: "Late", body: <p>Late mobile data</p> }));
  expect(screen.queryByText("Late mobile data")).not.toBeInTheDocument();
});

it.each(["one", "two"])("cancels a native mobile exit when reopening %s", async (id) => {
  environment.mobile = true;
  environment.reducedMotion = false;
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <StatefulBody label="Original" /> }));
  fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
  const sheet = screen.getByRole("dialog");
  const oldAnimation = deferredAnimation();
  const getAnimations = vi.fn(() => [{ finished: oldAnimation.promise } as Animation]);
  sheet.getAnimations = getAnimations;
  act(() => panel.close());
  await waitFor(() => expect(getAnimations).toHaveBeenCalled());
  act(() => panel.open({ id, title: "Reopened", body: <StatefulBody label="Mobile reopened" /> }));
  expect(screen.getByRole("dialog")).toBe(sheet);
  expect(sheet).not.toHaveAttribute("inert");
  expect(
    screen.getByRole("button", { name: id === "one" ? "Count: 1" : "Count: 0" }),
  ).toBeInTheDocument();
  const newAnimation = deferredAnimation();
  getAnimations.mockImplementation(() => [{ finished: newAnimation.promise } as Animation]);
  getAnimations.mockClear();
  act(() => panel.close());
  await waitFor(() => expect(getAnimations).toHaveBeenCalled());
  await act(async () => oldAnimation.resolve());
  expect(screen.getByText("Mobile reopened")).toBeInTheDocument();
  await act(async () => newAnimation.resolve());
  await waitFor(() => expect(sheet).not.toBeInTheDocument());
});

it("purges a native mobile exit on navigation or a breakpoint change", async () => {
  environment.mobile = true;
  environment.reducedMotion = false;
  const view = render(<Harness />);
  const request = { id: "one", title: "Details", body: <p>Old mobile body</p> };
  act(() => panel.open(request));
  const sheet = screen.getByRole("dialog");
  const finished = deferredAnimation();
  sheet.getAnimations = vi.fn(() => [{ finished: finished.promise } as Animation]);
  act(() => panel.close());
  expect(screen.getByText("Old mobile body")).toBeInTheDocument();
  environment.pathname = "/chat/two";
  view.rerender(<Harness />);
  expect(screen.queryByText("Old mobile body")).not.toBeInTheDocument();
  act(() => panel.open({ ...request, body: <p>New mobile body</p> }));
  await act(async () => finished.resolve());
  expect(screen.getByText("New mobile body")).toBeInTheDocument();
  const newSheet = screen.getByRole("dialog");
  newSheet.getAnimations = vi.fn(() => [
    { finished: new Promise<Animation>(() => {}) } as Animation,
  ]);
  act(() => panel.close());
  environment.mobile = false;
  view.rerender(<Harness />);
  expect(screen.queryByText("New mobile body")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { hidden: true })).not.toBeInTheDocument();
});

it("drops the old desktop host across breakpoints and cannot resurrect its pending exit", () => {
  environment.reducedMotion = false;
  environment.holdMotion = true;
  const view = render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel body</p> }));
  const desktop = screen.getByRole("complementary");
  environment.mobile = true;
  view.rerender(<Harness />);
  expect(desktop).not.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  environment.mobile = false;
  view.rerender(<Harness />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("complementary")).not.toBe(desktop);
  act(() => panel.close());
  const oldExit = lastExit();
  environment.mobile = true;
  view.rerender(<Harness />);
  expect(screen.queryByText("Panel body")).not.toBeInTheDocument();
  act(() => panel.open({ id: "two", title: "Mobile", body: <p>Mobile body</p> }));
  act(() => oldExit.complete(oldExit.target));
  expect(screen.getByText("Mobile body")).toBeInTheDocument();
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
  await waitFor(() => expect(rail.style.width).toBe("352px"));
  fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
  const counter = screen.getByRole("button", { name: "Count: 1" });
  const openTarget = animations.at(-1)?.target;

  fireEvent(document, new Event("visibilitychange"));
  fireEvent.focus(window);
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe("352px");
  expect(rail).toBeVisible();
  await act(async () => release(identity));
  expect(screen.getByRole("complementary")).toBe(rail);
  expect(rail.style.width).toBe("352px");
  expect(screen.getByRole("button", { name: "Count: 1" })).toBe(counter);
  expect(animations.at(-1)?.target).toBe(openTarget);

  // A real close/reopen still animates: the fix removed the false remount, not the motion.
  act(() => panel.close());
  expect(lastExit().target).toMatch(/^closed-/);
});
