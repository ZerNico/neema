import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopApprovals } from "./approvals.ts";

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

beforeEach(() => {
  window.localStorage.clear();
});

describe("useDesktopApprovals", () => {
  it("defaults to asking before changes, and runs reads on its own", async () => {
    const { result } = renderHook(() => useDesktopApprovals("c1"));
    expect(result.current.level).toBe("auto");
    expect(await settled(result.current.ask("r1", null))).toBe(true);
    expect(await settled(result.current.ask("e1", "edit"))).toBe("pending");
    expect(result.current.pending.get("e1")).toBe("edit");
  });

  it("asks about reads too under manual, and offers no blanket for them", async () => {
    const { result } = renderHook(() => useDesktopApprovals("c1"));
    act(() => result.current.setLevel("manual"));
    const read = result.current.ask("r1", null);
    expect(await settled(read)).toBe("pending");
    expect(result.current.pending.get("r1")).toBe("read");
    act(() => result.current.decide("r1", "allow-rest"));
    // "allow-rest" on a read is just "allow": the next read asks again.
    expect(await settled(read)).toBe(true);
    expect(await settled(result.current.ask("r2", null))).toBe("pending");
  });

  it("runs everything under skip, except a delete", async () => {
    const { result } = renderHook(() => useDesktopApprovals("c1"));
    act(() => result.current.setLevel("skip"));
    expect(await settled(result.current.ask("e1", "edit"))).toBe(true);
    expect(await settled(result.current.ask("x1", "command"))).toBe(true);
    expect(await settled(result.current.ask("d1", "delete"))).toBe("pending");
  });

  it("keeps a blanket edit grant from covering commands or deletes", async () => {
    const { result } = renderHook(() => useDesktopApprovals("c1"));
    const first = result.current.ask("e1", "edit");
    await settled(first);
    act(() => result.current.decide("e1", "allow-rest"));
    expect(await settled(first)).toBe(true);
    expect(await settled(result.current.ask("e2", "edit"))).toBe(true);
    expect(await settled(result.current.ask("x1", "command"))).toBe("pending");
    expect(await settled(result.current.ask("d1", "delete"))).toBe("pending");
  });

  it("answers a deny as false and remembers the level per conversation", async () => {
    const { result } = renderHook(() => useDesktopApprovals("c1"));
    const ask = result.current.ask("e1", "edit");
    await settled(ask);
    act(() => result.current.decide("e1", "deny"));
    expect(await settled(ask)).toBe(false);

    act(() => result.current.setLevel("skip"));
    const again = renderHook(() => useDesktopApprovals("c1"));
    expect(again.result.current.level).toBe("skip");
    const other = renderHook(() => useDesktopApprovals("c2"));
    expect(other.result.current.level).toBe("auto");
  });
});
