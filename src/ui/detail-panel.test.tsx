import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DetailPanelProvider,
  DetailPanelRail,
  useDetailPanel,
  useDetailPanelFocus,
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
  const focus = useDetailPanelFocus();
  return (
    <>
      <p>{label}</p>
      <p>Focus: {focus}</p>
      <button onClick={() => setCount((value) => value + 1)}>Count: {count}</button>
    </>
  );
}

function Harness() {
  return (
    <DetailPanelProvider>
      <Probe />
      <DetailPanelRail />
    </DetailPanelProvider>
  );
}

beforeEach(() => {
  environment.mobile = false;
  environment.pathname = "/chat/one";
});

describe.each([false, true])("detail panel (mobile=%s)", (mobile) => {
  it("refreshes same-ID props and focus without resetting body state; a different ID resets it", () => {
    environment.mobile = mobile;
    render(<Harness />);
    act(() =>
      panel.open({
        id: "one",
        title: "Details",
        body: <StatefulBody label="Original" />,
        focus: 1,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Count: 0" }));
    const counter = screen.getByRole("button", { name: "Count: 1" });

    act(() =>
      panel.open({
        id: "one",
        title: "Updated details",
        subtitle: "New subtitle",
        body: <StatefulBody label="Updated" />,
        focus: 2,
      }),
    );
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("New subtitle")).toBeInTheDocument();
    expect(screen.getByText("Focus: 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Count: 1" })).toBe(counter);

    act(() =>
      panel.open({ id: "two", title: "Other details", body: <StatefulBody label="Other body" /> }),
    );
    expect(screen.getByRole("button", { name: "Count: 0" })).not.toBe(counter);
    expect(screen.getByText("Other body")).toBeInTheDocument();
    expect(screen.queryByText("Focus: 2")).not.toBeInTheDocument();
  });

  it("still closes on navigation and explicit close", () => {
    environment.mobile = mobile;
    const view = render(<Harness />);
    act(() => panel.open({ id: "one", title: "Details", body: <p>Panel content</p> }));
    environment.pathname = "/chat/two";
    view.rerender(<Harness />);
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
