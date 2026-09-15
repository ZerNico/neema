import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResearchActivityBlock } from "./research-activity-block.tsx";
import { AppMotionProvider } from "~/ui/motion.tsx";
import { projectAssistantBody } from "./assistant-body.ts";
import { collectSources } from "./citations.ts";
import {
  applyToolChunk,
  type ResearchToolActivity,
  type CompactionActivity,
  type WebToolActivity,
} from "../client/use-message-stream.ts";

const root: ResearchToolActivity = {
  family: "research",
  callId: "run-1",
  runId: "run-1",
  name: "deep_research",
  status: "running",
  textOffset: 4,
  turnIndex: 0,
  callIndex: 0,
  progress: {
    runId: "run-1",
    phase: "researching",
    usageComplete: true,
    limitations: [],
    tasks: [
      {
        id: "task-2",
        ordinal: 2,
        title: "Second topic",
        status: "complete",
      },
      { id: "task-1", ordinal: 1, title: "First topic", status: "running" },
    ],
  },
};
const web: WebToolActivity = {
  family: "web",
  callId: "web-1",
  runId: "run-1",
  taskId: "task-1",
  name: "web_search",
  status: "complete",
  targets: ["primary evidence"],
  textOffset: 4,
  turnIndex: 5,
  sources: [
    {
      kind: "web" as const,
      index: 1,
      url: "https://example.org",
      title: "Evidence",
      snippet: "Finding",
      read: true,
    },
  ],
};

const compaction: CompactionActivity = {
  eventId: "compact-1",
  runId: "run-1",
  taskId: "task-1",
  beforeTurnIndex: 6,
  passIndex: 0,
  textOffset: 4,
  scope: "active_rounds",
  status: "complete",
  outcome: "summary",
  summary: "Internal worker context",
};
const envelope = (phase: string, progress: unknown) =>
  JSON.stringify({
    v: 1,
    family: "research",
    name: "deep_research",
    // Deliberately unequal: the observer mints the row, the handler the run.
    callId: "call-1",
    runId: "run-1",
    phase,
    textOffset: 4,
    progress,
  });

describe("research activity", () => {
  it("rolls changed targets inside a fixed line, keeps the action stable, and settles immediately", async () => {
    const onOpen = vi.fn();
    const tree = (target: string, settled = false) => (
      <AppMotionProvider>
        <ResearchActivityBlock
          activity={{
            ...root,
            status: settled ? "complete" : "running",
            progress: { ...root.progress!, phase: settled ? "complete" : "researching" },
          }}
          sourceCount={1}
          webActivities={[{ ...web, targets: [target] }]}
          onOpen={onOpen}
        />
      </AppMotionProvider>
    );
    const { rerender } = render(tree("First"));
    const row = screen.getByRole("button", { name: /Researching/ });
    const label = screen.getByText("Searching “First”");
    const phase = screen.getByText("Researching");
    const spinner = row.querySelector("svg");
    expect(label.parentElement).toHaveClass("h-5", "overflow-hidden");
    rerender(tree("First"));
    expect(screen.getByText("Searching “First”")).toBe(label);
    rerender(tree("Second"));
    rerender(tree("Latest"));
    // The phase and the rolling target are separate spans; jsdom keeps them
    // inline, so the space a browser derives from the grid is absent.
    expect(screen.getByRole("button", { name: /^Researching\s?Searching “Latest”$/ })).toBe(row);
    expect(screen.queryByText("Searching “First”")).toBeNull();
    expect(row.querySelectorAll("[inert]")).toHaveLength(1);
    const latest = screen.getByText("Searching “Latest”");
    expect(latest.style.transform).toContain("translateY(100%)");
    expect(screen.getByText("Researching")).toBe(phase);
    expect(row.querySelector("svg")).toBe(spinner);
    await waitFor(() => expect(row.querySelector("[inert]")).toBeNull());
    expect(latest.style.transform).toBe("none");
    rerender(tree("Latest", true));
    expect(screen.getByRole("button", { name: "Researched 1 source" })).toBe(row);
    expect(row).not.toHaveAttribute("aria-busy");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("reports what it is doing now, then the sources it read, and nothing else", () => {
    const { rerender } = render(<ResearchActivityBlock activity={root} webActivities={[web]} />);
    expect(screen.getByText("Researching")).toBeTruthy();
    expect(screen.getByText("Searching \u201cprimary evidence\u201d")).toBeTruthy();
    // The call has returned; the answer streaming in below is an ordinary reply.
    rerender(
      <ResearchActivityBlock
        activity={{
          ...root,
          status: "complete",
          sources: web.sources!,
          progress: { ...root.progress!, phase: "complete" },
        }}
        webActivities={[web]}
      />,
    );
    expect(screen.getByText("Researched 1 source")).toBeTruthy();
    expect(screen.queryByText(/Searching|Writing/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    // Task details belong in the panel, not the one-line transcript row.
    expect(screen.queryByText("First topic")).toBeNull();
    expect(screen.queryByText("Second topic")).toBeNull();
    expect(screen.queryByText("Internal worker context")).toBeNull();

    const onOpen = vi.fn();
    rerender(
      <ResearchActivityBlock
        activity={{
          ...root,
          status: "complete",
          sources: web.sources!,
          progress: { ...root.progress!, phase: "complete" },
        }}
        webActivities={[web]}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Researched 1 source" }));
    expect(onOpen).toHaveBeenCalled();

    rerender(
      <ResearchActivityBlock
        activity={{
          ...root,
          status: "error",
          progress: {
            ...root.progress!,
            phase: "interrupted",
            usageComplete: false,
            limitations: ["One source could not be read."],
          },
        }}
        webActivities={[web]}
      />,
    );
    expect(screen.getByText("Research interrupted")).toBeTruthy();
    // A failed read is not the reader's problem; the row never nags about it.
    expect(screen.queryByText(/coverage/)).toBeNull();

    // Sources gathered before the run ended early still lead: they are the part
    // the reader can open.
    rerender(
      <ResearchActivityBlock
        activity={{
          ...root,
          status: "error",
          sources: web.sources!,
          progress: { ...root.progress!, phase: "aborted", limitations: ["Stopped by you."] },
        }}
        webActivities={[web]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole("button", { name: /Researched 1 source/ })).toBeTruthy();
    expect(screen.getByText("stopped early")).toBeTruthy();
  });

  it("keeps one outer anchor and leaves orphaned web activity visible", () => {
    const parts = projectAssistantBody({
      content: "PlanReport",
      streaming: false,
      tools: [root, web],
      compactions: [compaction],
    }).parts;
    expect(parts.map((part) => part.kind)).toEqual(["text", "tool", "text"]);
    expect(parts.filter((part) => part.kind === "text").map((part) => part.content)).toEqual([
      "Plan",
      "Report",
    ]);
    expect(
      projectAssistantBody({
        content: "PlanReport",
        streaming: false,
        tools: [web],
        compactions: [],
      }).parts.map((part) => part.kind),
    ).toEqual(["text", "web", "text"]);
    expect(collectSources([{ ...root, sources: web.sources! }, web])).toEqual(web.sources);
  });

  it("validates snapshot identity and keeps terminal progress ahead of replay", () => {
    const started = applyToolChunk([], envelope("start", root.progress));
    expect(started).toHaveLength(1);
    expect(
      applyToolChunk(started, envelope("progress", { ...root.progress, runId: "other" })),
    ).toBe(started);
    expect(
      applyToolChunk(started, envelope("progress", { ...root.progress, tasks: "wrong" })),
    ).toBe(started);
    const complete = applyToolChunk(
      started,
      envelope("result", { ...root.progress, phase: "complete" }),
    );
    expect(complete[0]).toMatchObject({
      status: "complete",
      textOffset: 4,
      progress: { phase: "complete" },
    });
    expect(applyToolChunk(complete, envelope("progress", root.progress))).toBe(complete);
    const child = applyToolChunk(
      [],
      JSON.stringify({
        v: 1,
        family: "web",
        phase: "start",
        name: "web_search",
        callId: "child",
        runId: "run-1",
        taskId: "task-1",
        args: { targets: [] },
      }),
    );
    expect(child[0]).toMatchObject({ runId: "run-1", taskId: "task-1" });
  });
});
