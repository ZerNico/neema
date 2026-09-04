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
    [activity("complete", "rejected"), "Couldn’t save memory"],
    [activity("error"), "Couldn’t save memory"],
  ] as const)("renders the summary label %#", (value, label) => {
    render(<MemoryActivityBlock activity={value} />);
    expect(screen.getByText(label)).toBeInTheDocument();
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
