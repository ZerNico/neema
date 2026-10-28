import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PendingKind } from "~/modules/desktop/client/approvals.ts";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { ApprovalDock, type DockApproval } from "./approval-dock.tsx";

const show = (element: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>);

const parked = (
  callId: string,
  command: string,
  kind: PendingKind = "command",
  over: Partial<DesktopToolActivity> = {},
): DockApproval & { family: "desktop" } => ({
  family: "desktop",
  callId,
  activity: {
    family: "desktop",
    callId,
    name: "run_command",
    status: "running",
    args: { command },
    ...over,
  },
  approval: { kind, decide: vi.fn() },
});

describe("ApprovalDock", () => {
  it("asks one call at a time and pages through the rest", async () => {
    const first = parked("a", "pnpm lint");
    const second = parked("b", "pnpm test");
    show(<ApprovalDock items={[first, second]} />);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("pnpm lint")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next request" }));
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(second.approval.decide).toHaveBeenCalledWith("allow");
    expect(first.approval.decide).not.toHaveBeenCalled();
  });

  it("moves to the next call once the shown one is decided", () => {
    const first = parked("a", "pnpm lint");
    const second = parked("b", "pnpm test");
    const { rerender } = show(<ApprovalDock items={[first, second]} />);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalDock items={[second]} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.queryByText("1 of 1")).not.toBeInTheDocument();
  });

  it("allows a batch of the same call at once", async () => {
    const items = [parked("a", "pnpm lint"), parked("b", "pnpm test")];
    show(<ApprovalDock items={items} />);
    await userEvent.click(screen.getByRole("button", { name: "Allow all 2" }));
    for (const item of items) expect(item.approval.decide).toHaveBeenCalledWith("allow");
  });

  it("never batches what has to be read call by call", () => {
    const deletes = [
      parked("a", "", "delete", { name: "delete_files", args: { paths: ["a.txt"] } }),
      parked("b", "", "delete", { name: "delete_files", args: { paths: ["b.txt"] } }),
    ];
    const { unmount } = show(<ApprovalDock items={deletes} />);
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();
    unmount();
    const mixed = [parked("a", "pnpm lint"), parked("b", "", "read", { name: "read_file" })];
    show(<ApprovalDock items={mixed} />);
    expect(screen.queryByRole("button", { name: /Allow all/ })).not.toBeInTheDocument();
  });
});
