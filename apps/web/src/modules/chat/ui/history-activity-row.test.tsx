import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  applyToolChunk,
  type HistoryToolActivity,
  type ToolActivity,
} from "../client/use-message-stream.ts";
import { HistoryActivityRow } from "./history-activity-row.tsx";
import { toActivity } from "./stored-activities.ts";
import { stepLabel } from "./work-steps.ts";

const chunk = (value: object) => JSON.stringify({ v: 1, family: "history", ...value });

const stored = (toolName: string, result: unknown, status: "complete" | "error" = "complete") =>
  toActivity({
    id: "row",
    toolName,
    family: "history",
    arguments: {},
    result,
    status,
    turnIndex: 0,
    callIndex: 0,
    error: null,
  }) as HistoryToolActivity;

const label = (activity: ToolActivity | undefined) => {
  const { container, unmount } = render(
    <HistoryActivityRow activity={activity as HistoryToolActivity} />,
  );
  const text = container.textContent;
  unmount();
  return text;
};

describe("a history call", () => {
  it("shows the same row live and after a reload", () => {
    let live: ToolActivity[] = applyToolChunk(
      [],
      chunk({ phase: "start", callId: "row", name: "read_history", turnIndex: 0, callIndex: 0 }),
    );
    expect(label(live[0])).toContain("Looking back in this chat");
    live = applyToolChunk(
      live,
      chunk({ phase: "result", callId: "row", name: "read_history", ok: true, from: 1, to: 8 }),
    );
    const reloaded = stored("read_history", { ok: true, from: 1, to: 8, total: 30 });
    expect(live).toEqual([expect.objectContaining({ family: "history", status: "complete" })]);
    expect(reloaded).toMatchObject({ family: "history", status: "complete" });
    expect(label(live[0])).toContain("Read messages 1–8 of this chat");
    render(<HistoryActivityRow activity={reloaded} />);
    expect(screen.getByText("Read messages 1–8 of this chat")).toBeInTheDocument();
  });

  it("names what each tool did", () => {
    expect(label(stored("read_history", { ok: true, query: "ledger", matches: 1 }))).toContain(
      "Found 1 earlier message for “ledger”",
    );
    expect(label(stored("search_chats", { ok: true, query: "car", matches: 3 }))).toContain(
      "Found 3 chats for “car”",
    );
    expect(label(stored("search_chats", { ok: true, query: "wqd", matches: 0 }))).toContain(
      "No chats found for “wqd”",
    );
    expect(
      label(stored("read_chat", { ok: true, chatTitle: "Trip", from: 1, to: 2, total: 2 })),
    ).toContain("Read “Trip”");
    expect(
      label(stored("read_chat", { ok: true, chatTitle: "Trip", from: 1, to: 20, total: 40 })),
    ).toContain("Read messages 1–20 of “Trip”");
    expect(label(stored("read_chat", { ok: false, error: "No chat." }, "error"))).toContain(
      "Couldn’t read the chat",
    );
  });

  it("groups under the work line with its own step label", () => {
    const activity = stored("search_chats", { ok: true, query: "x", matches: 0 });
    expect(stepLabel({ kind: "tool", key: "row", activity } as never)).toBe(
      "Searching your other chats",
    );
  });
});
