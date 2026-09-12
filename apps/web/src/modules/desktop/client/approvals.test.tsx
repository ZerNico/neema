import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { useDesktopApprovals } from "./approvals.ts";

const hook = (level: PermissionLevel = "auto") =>
  renderHook((props: { level: PermissionLevel }) => useDesktopApprovals(props.level), {
    initialProps: { level },
  });

// The level and the blanket grants are the two things that decide whether a
// call waits on the reader. Each rule below is one a reader would notice
// breaking: a read that suddenly asks, or a delete that suddenly does not.
const settled = async (promise: Promise<boolean>) => {
  let outcome: boolean | "pending" = "pending";
  void promise.then((value) => {
    outcome = value;
  });
  await act(async () => {});
  return outcome;
};

describe("useDesktopApprovals", () => {
  it("defaults to asking before changes, and runs reads on its own", async () => {
    const { result } = hook();
    expect(await settled(result.current.ask("r1", null))).toBe(true);
    expect(await settled(result.current.ask("e1", "edit"))).toBe("pending");
    expect(result.current.pending.get("e1")).toBe("edit");
  });

  it("asks about reads too under manual, and offers no blanket for them", async () => {
    const { result } = hook("manual");
    const read = result.current.ask("r1", null);
    expect(await settled(read)).toBe("pending");
    expect(result.current.pending.get("r1")).toBe("read");
    act(() => result.current.decide("r1", "allow-rest"));
    // "allow-rest" on a read is just "allow": the next read asks again.
    expect(await settled(read)).toBe(true);
    expect(await settled(result.current.ask("r2", null))).toBe("pending");
  });

  it("runs everything under skip, except a delete", async () => {
    const { result } = hook("skip");
    expect(await settled(result.current.ask("e1", "edit"))).toBe(true);
    expect(await settled(result.current.ask("x1", "command"))).toBe(true);
    expect(await settled(result.current.ask("d1", "delete"))).toBe("pending");
  });

  it("keeps a blanket edit grant from covering commands or deletes", async () => {
    const { result } = hook();
    const first = result.current.ask("e1", "edit");
    await settled(first);
    act(() => result.current.decide("e1", "allow-rest"));
    expect(await settled(first)).toBe(true);
    expect(await settled(result.current.ask("e2", "edit"))).toBe(true);
    expect(await settled(result.current.ask("x1", "command"))).toBe("pending");
    expect(await settled(result.current.ask("d1", "delete"))).toBe("pending");
  });

  it("answers a deny as false, and applies a changed level to the next call", async () => {
    const { result, rerender } = hook();
    const ask = result.current.ask("e1", "edit");
    await settled(ask);
    act(() => result.current.decide("e1", "deny"));
    expect(await settled(ask)).toBe(false);

    rerender({ level: "skip" });
    expect(await settled(result.current.ask("e2", "edit"))).toBe(true);
  });
});
