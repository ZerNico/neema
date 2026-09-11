import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopActivityBlock } from "./desktop-activity-block.tsx";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";

const running = (over: Partial<DesktopToolActivity> = {}): DesktopToolActivity => ({
  family: "desktop",
  callId: "call-1",
  name: "run_command",
  status: "running",
  turnIndex: 0,
  callIndex: 0,
  args: { command: "pnpm test" },
  ...over,
});

describe("DesktopActivityBlock", () => {
  it("is pressable while the message is still streaming", async () => {
    const decide = vi.fn();
    render(<DesktopActivityBlock activity={running()} approval={{ kind: "command", decide }} />);
    // The clarification card is disabled mid-stream because answering it ends
    // the turn. This one is the inverse: the generation is parked on it.
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(decide).toHaveBeenCalledWith("allow");
  });

  it("offers a blanket grant naming only its own kind", async () => {
    const decide = vi.fn();
    render(<DesktopActivityBlock activity={running()} approval={{ kind: "command", decide }} />);
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow commands for this chat" }));
    expect(decide).toHaveBeenCalledWith("allow-rest");

    decide.mockClear();
    render(
      <DesktopActivityBlock
        activity={running({
          callId: "call-2",
          name: "write_local_file",
          args: { path: "src/index.ts" },
        })}
        approval={{ kind: "edit", decide }}
      />,
    );
    expect(screen.getByRole("button", { name: "Allow edits for this chat" })).toBeInTheDocument();
  });

  it("offers no blanket grant for a delete", () => {
    const decide = vi.fn();
    render(
      <DesktopActivityBlock
        activity={running({ callId: "call-3", name: "delete_local_file", args: { path: "old/" } })}
        approval={{ kind: "delete", decide }}
      />,
    );
    expect(screen.getByText("Delete from this computer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /for this chat/ })).not.toBeInTheDocument();
  });

  it("shows a plain row, with no way to act, once the call is decided", () => {
    render(
      <DesktopActivityBlock
        activity={running({
          status: "complete",
          result: {
            v: 1,
            ok: true,
            summary: "Ran pnpm test",
            detail: "3 passed",
            truncated: false,
          },
        })}
      />,
    );
    expect(screen.getByText("Ran pnpm test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("reads as history in a browser, where no approval is offered", () => {
    render(<DesktopActivityBlock activity={running()} />);
    expect(screen.getByText("Running pnpm test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });
});
