import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  useDetailPanelSelectedId,
  type DetailPanelApi,
} from "./detail-panel.tsx";

const environment = vi.hoisted(() => ({ mobile: false, pathname: "/chat/one" }));
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => environment.pathname }));
vi.mock("~/ui/use-mobile", () => ({ useIsMobile: () => environment.mobile }));

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
      <DetailPanelProvider>
        <Probe />
        <SelectionProbe />
        <DetailPanelRail />
      </DetailPanelProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  environment.mobile = false;
  environment.pathname = "/chat/one";
  selectionRender.mockClear();
});

describe.each([false, true])("detail panel (mobile=%s)", (mobile) => {
  it("refreshes same-ID props without resetting body state; a different ID resets it", () => {
    environment.mobile = mobile;
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

it("closes the desktop rail on Escape", () => {
  render(<Harness />);
  act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
});
