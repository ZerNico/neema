import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MemoryToolActivity } from "../client/use-message-stream.ts";
import { MemoryActivityBlock } from "./memory-activity-block.tsx";

const activity = (
  status: MemoryToolActivity["status"],
  outcome?: MemoryToolActivity["outcome"],
): MemoryToolActivity => ({
  family: "memory",
  callId: "memory-1",
  name: "save_memory",
  status,
  ...(outcome ? { outcome } : {}),
});

describe("MemoryActivityBlock", () => {
  it.each([
    [activity("running"), "Saving to memory…"],
    [activity("complete", "created"), "Saved to memory"],
    [activity("complete", "updated"), "Updated memory"],
    [activity("complete", "unchanged"), "Memory already saved"],
    [activity("error", "rejected"), "No memory saved"],
    [activity("error"), "Couldn’t save memory"],
  ] as const)("renders the summary label %#", (value, label) => {
    render(<MemoryActivityBlock activity={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // A refusal is the model's decision, not something the user can fix, so it
  // must not wear the warning that marks an actual failure.
  it("marks a transport failure with a warning but a refusal as an ordinary outcome", () => {
    const { container: refused } = render(
      <MemoryActivityBlock activity={{ ...activity("error", "rejected"), reason: "sensitive" }} />,
    );
    expect(refused.querySelector(".text-warning")).toBeNull();
    const { container: failed } = render(<MemoryActivityBlock activity={activity("error")} />);
    expect(failed.querySelector(".text-warning")).not.toBeNull();
  });

  it("never renders disclosure controls, links, favicons, or memory content", () => {
    const { container } = render(
      <MemoryActivityBlock
        activity={{
          ...activity("complete", "created"),
          error: "private memory content must not appear",
        }}
      />,
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/private memory content/)).toBeNull();
  });
});
