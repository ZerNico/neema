import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyToolChunk, type ToolActivity } from "../client/use-message-stream.ts";
import { NotifyActivityRow } from "./notify-activity-row.tsx";
import { toActivity } from "./stored-activities.ts";

const chunk = (value: object) => JSON.stringify({ v: 1, family: "notify", ...value });

describe("a scheduled run telling its owner", () => {
  it("shows the same row live and after a reload", () => {
    let live: ToolActivity[] = applyToolChunk(
      [],
      chunk({ phase: "start", callId: "row", name: "notify_user", turnIndex: 0, callIndex: 0 }),
    );
    live = applyToolChunk(
      live,
      chunk({ phase: "result", callId: "row", name: "notify_user", ok: true, message: "It fell." }),
    );
    const stored = toActivity({
      id: "row",
      toolName: "notify_user",
      family: "notify",
      arguments: {},
      result: { v: 1, outcome: "queued", message: "It fell." },
      status: "complete",
      turnIndex: 0,
      callIndex: 0,
      error: null,
    });
    expect(live).toEqual([expect.objectContaining({ family: "notify", message: "It fell." })]);
    expect(stored).toMatchObject({ family: "notify", status: "complete", message: "It fell." });
    render(<NotifyActivityRow activity={stored as never} />);
    expect(screen.getByText("Notified you: It fell.")).toBeInTheDocument();
  });

  it("says so when the call was refused", () => {
    const stored = toActivity({
      id: "row",
      toolName: "notify_user",
      family: "notify",
      arguments: {},
      result: { v: 1, outcome: "rejected", message: "This answer already notified its owner." },
      status: "error",
      turnIndex: 0,
      callIndex: 0,
      error: { code: "NotifyRejected", message: "already" },
    });
    render(<NotifyActivityRow activity={stored as never} />);
    expect(screen.getByText("Couldn’t notify you")).toBeInTheDocument();
  });
});
