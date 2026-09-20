import { describe, expect, it } from "vitest";
import { foreignMachineStamp } from "./foreign-machine-banner.tsx";

const attempts = (entries: Array<[string, string | null]>) =>
  entries.map(([messageId, id]) => ({
    messageId,
    desktopMachine: id === null ? null : { id, name: `Machine ${id}` },
  }));

describe("foreignMachineStamp", () => {
  it("is absent on the machine that sent the latest attempt", () => {
    expect(
      foreignMachineStamp(
        "chat",
        "a",
        attempts([["m1", "a"]]),
        ["m1"],
      ),
    ).toBeNull();
  });

  it("is absent where no attempt ever came from a machine (browser sends)", () => {
    expect(
      foreignMachineStamp("chat", "a", attempts([["m1", null]]), ["m1"]),
    ).toBeNull();
  });

  it("is absent in a browser, which has no machine id", () => {
    expect(foreignMachineStamp("chat", null, attempts([["m1", "a"]]), ["m1"])).toBeNull();
  });

  it("names the machine the latest stamped attempt came from", () => {
    expect(
      foreignMachineStamp(
        "chat",
        "b",
        attempts([
          ["m1", "a"],
          ["m2", "a"],
        ]),
        ["m1", "m2"],
      ),
    ).toEqual({ id: "a", name: "Machine a" });
  });

  it("reads message position, not generation-row order, for the latest stamp", () => {
    // The newest row is m2; it carries no stamp, so the stamp of m1 decides.
    expect(
      foreignMachineStamp(
        "chat",
        "b",
        [
          { messageId: "m2", desktopMachine: null },
          { messageId: "m1", desktopMachine: { id: "a", name: "Machine a" } },
        ],
        ["m1", "m2"],
      ),
    ).toEqual({ id: "a", name: "Machine a" });
  });

  it("a send from this machine after taking over hides the banner", () => {
    const rows = attempts([
      ["m1", "a"],
      ["m2", "b"],
    ]);
    expect(foreignMachineStamp("chat", "b", rows, ["m1", "m2"])).toBeNull();
  });
});
