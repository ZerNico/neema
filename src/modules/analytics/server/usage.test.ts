import { describe, expect, it } from "vitest";
import { emptyUsageTotals, resolveCost } from "./usage.ts";
describe("image output costs", () => {
  const totals = { ...emptyUsageTotals(), inputTokens: 100, outputTokens: 100 };
  const pricing = { input: 1, output: 2 };
  it("never applies text pricing to image attempts", () => {
    expect(resolveCost(totals, pricing, "images")).toEqual({ cost: null, costSource: null });
    expect(resolveCost(totals, pricing)).toEqual({ cost: 0.0003, costSource: "pricing" });
  });
  it("preserves complete provider cost and refuses a partial sum", () => {
    expect(resolveCost({ ...totals, providerCost: 0.05 }, pricing, "images")).toEqual({
      cost: 0.05,
      costSource: "provider",
    });
    expect(resolveCost({ ...totals, providerCost: 0.05 }, pricing, "incomplete-images")).toEqual({
      cost: null,
      costSource: null,
    });
  });
});
