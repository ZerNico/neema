import { Response } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { addFinishUsage, emptyUsageTotals, resolveCost } from "./usage.ts";

const turn = (input: number, output: number, cost?: number) => ({
  usage: new Response.Usage({ inputTokens: { total: input }, outputTokens: { total: output } }),
  metadata: cost === undefined ? {} : { modelClient: { cost } },
});
const totalsOf = (...turns: ReadonlyArray<ReturnType<typeof turn>>) => {
  const totals = emptyUsageTotals();
  for (const item of turns) addFinishUsage(totals, item);
  return totals;
};
const pricing = { input: 1, output: 2 };

describe("image output costs", () => {
  it("never applies text pricing to image attempts", () => {
    expect(resolveCost(totalsOf(turn(100, 100)), pricing, "images")).toEqual({
      cost: null,
      costSource: null,
    });
    expect(resolveCost(totalsOf(turn(100, 100)), pricing)).toEqual({
      cost: 0.0003,
      costSource: "pricing",
    });
  });
  it("preserves complete provider cost and refuses a partial sum", () => {
    expect(resolveCost(totalsOf(turn(100, 100, 0.05)), pricing, "images")).toEqual({
      cost: 0.05,
      costSource: "provider",
    });
    expect(resolveCost(totalsOf(turn(100, 100, 0.05)), pricing, "incomplete-images")).toEqual({
      cost: null,
      costSource: null,
    });
  });
});

describe("costs across rounds", () => {
  it("prices the rounds a provider did not cover, and labels the sum as estimated", () => {
    expect(resolveCost(totalsOf(turn(100, 100, 0.01), turn(100, 100)), pricing)).toEqual({
      cost: 0.0103,
      costSource: "pricing",
    });
  });
  it("leaves the cost unknown when an uncovered round cannot be priced", () => {
    expect(resolveCost(totalsOf(turn(100, 100, 0.01), turn(100, 100)), null)).toEqual({
      cost: null,
      costSource: null,
    });
  });
  it("leaves the cost unknown when a turn reported neither usage nor a cost", () => {
    const totals = totalsOf(turn(100, 10, 0.01));
    addFinishUsage(totals, {
      usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }),
      metadata: {},
    });
    expect(resolveCost(totals, pricing)).toEqual({ cost: null, costSource: null });
  });
  it("prices cached reads and writes at their own rates", () => {
    const totals = emptyUsageTotals();
    addFinishUsage(totals, {
      usage: new Response.Usage({
        inputTokens: { total: 1000, cacheRead: 600, cacheWrite: 200 },
        outputTokens: { total: 0 },
      }),
    });
    // 200 uncached at 1, 600 read at 0.1, 200 written at 1.25, per 1M tokens.
    expect(
      resolveCost(totals, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }).cost,
    ).toBeCloseTo((200 + 60 + 250) / 1_000_000, 12);
  });
});
