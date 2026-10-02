import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  stampToolTimes,
  type ToolActivity,
  type WebToolActivity,
} from "../client/use-message-stream.ts";
import type { WorkPart } from "./assistant-body.ts";
import { WorkGroupBlock, workSummary } from "./work-group-block.tsx";

const call = (callId: string, overrides: Partial<ToolActivity> = {}): ToolActivity =>
  ({
    family: "web",
    name: "web_search",
    callId,
    turnIndex: 0,
    callIndex: 0,
    status: "complete",
    targets: [callId],
    ...overrides,
  }) as ToolActivity;

const group = (...activities: ToolActivity[]): WorkPart => ({
  kind: "work",
  key: "work-1",
  steps: [
    { kind: "reasoning", key: "reasoning" },
    {
      kind: "web",
      key: "web-1",
      activities: activities.filter((a): a is WebToolActivity => a.family === "web"),
    },
    ...activities
      .filter((a) => a.family === "desktop")
      .map((activity) => ({
        kind: "tool" as const,
        key: activity.callId,
        activity: activity as never,
      })),
  ],
});

const renderGroup = (part: WorkPart, live: boolean) =>
  render(
    <WorkGroupBlock
      part={part}
      live={live}
      renderStep={(step) => <p key={step.key}>step {step.kind}</p>}
    />,
  );

describe("a run of work", () => {
  it("names the current step with a running clock while it is live, and stays open", () => {
    const now = Date.now();
    renderGroup(group(call("a", { status: "running", startedAt: now - 5_000 })), true);
    const header = screen.getByRole("button", { name: /^Searching the web · \d+s/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("step web")).toBeInTheDocument();
  });

  it("folds into how long it worked once settled, and never hides a failure", () => {
    renderGroup(
      group(
        call("a", { startedAt: 1_000, completedAt: 20_000 }),
        call("b", {
          family: "desktop",
          name: "run_command",
          status: "error",
          startedAt: 21_000,
          completedAt: 43_000,
        }),
      ),
      false,
    );
    const header = screen.getByRole("button", { name: /^Worked for 42s\s?· 1 failed/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("sums itself up in words when the calls carry no timing", () => {
    expect(
      workSummary([
        { kind: "reasoning", key: "r" },
        { kind: "web", key: "w", activities: [call("a") as never] },
        { kind: "compaction", key: "c", activity: {} as never },
      ]),
    ).toBe("Thought, searched the web and summarized earlier messages");
  });
});

describe("tool timing", () => {
  it("stamps a new call started, a settled one completed, and keeps both across chunks", () => {
    const started = stampToolTimes([], [call("a", { status: "running" })], 100);
    expect(started[0]).toMatchObject({ startedAt: 100 });
    expect(started[0]).not.toHaveProperty("completedAt");
    // A family reducer rebuilds the activity without timing; it is carried over.
    const settled = stampToolTimes(started, [call("a", { status: "complete" })], 250);
    expect(settled[0]).toMatchObject({ startedAt: 100, completedAt: 250 });
    const later = stampToolTimes(settled, [call("a", { status: "complete" })], 900);
    expect(later[0]).toMatchObject({ startedAt: 100, completedAt: 250 });
  });
});
