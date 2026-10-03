import { describe, expect, it } from "vitest";
import { appendReplay, replayUnitOf } from "./provider-replay.ts";

const unit = (data: string) => ({
  v: 1,
  id: "u1",
  identity: {
    provider: "p",
    baseUrl: "https://p.test/v1",
    format: "chat-completions",
    model: "m",
  },
  format: "chat-completions",
  reasoningDetails: [{ type: "reasoning.encrypted", data }],
});

describe("provider replay", () => {
  it("keeps only valid, non-empty units", () => {
    expect(replayUnitOf(unit("x"))).toMatchObject({ id: "u1" });
    expect(replayUnitOf({ ...unit("x"), reasoningDetails: [] })).toBeNull();
    expect(replayUnitOf({ ...unit("x"), identity: { provider: "p" } })).toBeNull();
    expect(replayUnitOf({ v: 9 })).toBeNull();
  });
  it("drops a round that would push an answer past the bound", () => {
    const small = appendReplay(null, {
      turnIndex: 0,
      startOffset: 0,
      endOffset: 0,
      unit: replayUnitOf(unit("x"))!,
    });
    expect(small?.turns).toHaveLength(1);
    const big = appendReplay(small, {
      turnIndex: 1,
      startOffset: 0,
      endOffset: 0,
      unit: replayUnitOf(unit("x".repeat(2_000_000)))!,
    });
    expect(big).toBe(small);
  });
});
