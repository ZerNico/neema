import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  stampToolTimes,
  type ToolActivity,
  type WebToolActivity,
} from "../client/use-message-stream.ts";
import type { WorkPart } from "./assistant-body.ts";
import { WorkGroupBlock } from "./work-group-block.tsx";
import { workSummary } from "./work-steps.ts";
import type { DocumentPart } from "./assistant-body.ts";

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
  it("says it is working, with a running clock, while live, and stays open", () => {
    const now = Date.now();
    renderGroup(group(call("a", { status: "running", startedAt: now - 5_000 })), true);
    const header = screen.getByRole("button", { name: /^Working · [5-9]s/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("step web")).toBeInTheDocument();
  });

  it("still says it is working between calls, rather than seeming to stall", () => {
    renderGroup(group(call("a", { startedAt: Date.now() - 2_000, completedAt: Date.now() })), true);
    expect(screen.getByRole("button", { name: /^Working · \d+s/ })).toBeInTheDocument();
  });

  it("folds into what it did once settled, without counting steps the model worked around", () => {
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
    const header = screen.getByRole("button", { name: "Searched the web and ran a command" });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("holds itself open and says so while a step waits on the person", () => {
    const parked = call("p", { family: "desktop", name: "run_command", status: "running" });
    render(
      <WorkGroupBlock
        part={group(parked)}
        live={false}
        approvals={new Map([["p", {}]])}
        renderStep={(step) => <p key={step.key}>step {step.kind}</p>}
      />,
    );
    const header = screen.getByRole("button", { name: /^Waiting for you/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("step tool")).toBeInTheDocument();
  });

  it("sums itself up by what it did, naming thinking only when that was all", () => {
    const read = call("r", { name: "read_url", targets: ["https://a.test", "https://b.test"] });
    expect(
      workSummary([
        { kind: "reasoning", key: "r" },
        { kind: "web", key: "w", activities: [call("a"), read] as never },
        { kind: "compaction", key: "c", activity: {} as never },
      ]),
    ).toBe("Searched the web, read 2 pages and summarized earlier messages");
    expect(workSummary([{ kind: "reasoning", key: "r" }])).toBe("Thought");
  });

  it("names an access request as one, not as looking through files", () => {
    const desktop = (name: "request_network_access" | "request_path_access" | "find_files") => ({
      kind: "tool" as const,
      key: name,
      activity: call(name, { family: "desktop", name }) as never,
    });
    expect(workSummary([desktop("request_network_access")])).toBe("Asked for access");
    expect(workSummary([desktop("find_files"), desktop("request_path_access")])).toBe(
      "Looked through files and asked for access",
    );
  });

  it("leaves a failed document step out of the summary unless it was all there was", () => {
    const document = (callId: string, outcome: "updated" | "conflict"): DocumentPart => ({
      kind: "document",
      key: callId,
      documentId: "doc",
      activities: [
        {
          family: "document",
          name: "edit_document",
          callId,
          status: "complete",
          result: { outcome, documentId: "doc" },
        },
      ],
    });
    const web = { kind: "web", key: "w", activities: [call("a")] as never } as const;
    expect(workSummary([web, document("x", "conflict"), document("y", "updated")])).toBe(
      "Searched the web and edited the document",
    );
    expect(workSummary([document("x", "conflict")])).toBe("Couldn’t update the document");
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
