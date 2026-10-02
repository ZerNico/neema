import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyToolChunk, type PlanToolActivity } from "../client/use-message-stream.ts";
import { PlanActivityBlock } from "./plan-activity-block.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";

vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const activity = (steps: PlanToolActivity["steps"], status = "complete"): PlanToolActivity => ({
  family: "plan",
  callId: "plan-1",
  name: "update_plan",
  status: status as PlanToolActivity["status"],
  turnIndex: 0,
  callIndex: 0,
  ...(steps ? { steps } : {}),
});
const show = (value: PlanToolActivity) =>
  render(
    <AppMotionProvider>
      <PlanActivityBlock activity={value} />
    </AppMotionProvider>,
  );

describe("checklist activity", () => {
  it("collapses to the current step and expands to the whole list", () => {
    show(
      activity([
        { step: "Read the filing", status: "completed" },
        { step: "Compare the terms", status: "in_progress" },
        { step: "Summarize", status: "pending" },
      ]),
    );
    const trigger = screen.getByRole("button", { name: /Compare the terms/ });
    expect(trigger).toHaveTextContent("1 of 3");
    expect(screen.queryByText("Summarize")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Summarize")).toBeInTheDocument();
  });

  it("summarizes progress without claiming the work was verified", () => {
    show(
      activity([
        { step: "Draft", status: "completed" },
        { step: "Review", status: "completed" },
      ]),
    );
    expect(screen.getByRole("button", { name: /Checklist · 2 of 2 done/ })).toBeInTheDocument();
    expect(screen.queryByText(/verified|confirmed|complete coverage/i)).not.toBeInTheDocument();
  });

  it("shows a plain row while updating and when the call failed", () => {
    const running = show(activity(undefined, "running"));
    expect(screen.getByText("Updating the checklist")).toBeInTheDocument();
    running.unmount();
    show(activity(undefined, "error"));
    expect(screen.getByText("Couldn’t update the checklist")).toBeInTheDocument();
  });

  it("replaces the previous list from the stream rather than appending to it", () => {
    const start = applyToolChunk(
      [],
      JSON.stringify({
        v: 1,
        family: "plan",
        phase: "start",
        callId: "plan-1",
        name: "update_plan",
        turnIndex: 0,
        callIndex: 0,
      }),
    );
    expect(start[0]).toMatchObject({ family: "plan", status: "running" });
    const result = applyToolChunk(
      start,
      JSON.stringify({
        v: 1,
        family: "plan",
        phase: "result",
        callId: "plan-1",
        name: "update_plan",
        ok: true,
        steps: [{ step: "Only step", status: "completed" }],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "complete",
      steps: [{ step: "Only step", status: "completed" }],
    });
    // A malformed list is an error row, never a half-applied checklist.
    const broken = applyToolChunk(
      applyToolChunk(
        [],
        JSON.stringify({
          v: 1,
          family: "plan",
          phase: "start",
          callId: "plan-2",
          name: "update_plan",
          turnIndex: 0,
          callIndex: 1,
        }),
      ),
      JSON.stringify({
        v: 1,
        family: "plan",
        phase: "result",
        callId: "plan-2",
        name: "update_plan",
        ok: true,
        steps: [{ step: "", status: "nope" }],
      }),
    );
    expect(broken[0]).toMatchObject({ status: "error" });
    expect(broken[0]).not.toHaveProperty("steps");
  });
});
