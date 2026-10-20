import { describe, expect, it } from "vitest";
import { effectiveLimits, limitKey, type LimitRule } from "./rules.ts";

const rule = (overrides: Partial<LimitRule> & Pick<LimitRule, "id">): LimitRule => ({
  groupId: null,
  metric: "cost",
  period: "month",
  amount: 10,
  modelIds: null,
  ...overrides,
});

describe("effective limits", () => {
  const monthly = rule({ id: "everyone-month" });
  const daily = rule({ id: "everyone-day", period: "day", amount: 2 });

  it("holds everyone to everyone's rules when no group says otherwise", () => {
    expect(effectiveLimits([monthly, daily], []).map((limit) => limit.ruleId)).toEqual([
      "everyone-month",
      "everyone-day",
    ]);
  });

  it("lets a group replace one limit and leaves the others", () => {
    const raised = rule({ id: "power-month", groupId: "power", amount: 50 });
    expect(effectiveLimits([monthly, daily], [raised])).toEqual([
      expect.objectContaining({ ruleId: "power-month", amount: 50 }),
      expect.objectContaining({ ruleId: "everyone-day", amount: 2 }),
    ]);
  });

  it("takes the most generous of several groups, and a lowered limit is a limit too", () => {
    const raised = rule({ id: "power", groupId: "power", amount: 50 });
    const lowered = rule({ id: "interns", groupId: "interns", amount: 5 });
    expect(effectiveLimits([monthly], [lowered, raised])).toEqual([
      expect.objectContaining({ ruleId: "power", amount: 50 }),
    ]);
    expect(effectiveLimits([monthly], [lowered])).toEqual([
      expect.objectContaining({ ruleId: "interns", amount: 5 }),
    ]);
  });

  it("lifts a limit for a group that says No limit, whatever another group says", () => {
    const lifted = rule({ id: "devs", groupId: "devs", period: "day", amount: null });
    const other = rule({ id: "interns", groupId: "interns", period: "day", amount: 1 });
    expect(effectiveLimits([monthly, daily], [other, lifted]).map((l) => l.ruleId)).toEqual([
      "everyone-month",
    ]);
  });

  it("keeps a group's own limit that everyone has no rule for", () => {
    const opus = rule({
      id: "opus",
      groupId: "g",
      metric: "answers",
      period: "day",
      amount: 20,
      modelIds: ["opus"],
    });
    expect(effectiveLimits([monthly], [opus]).map((l) => l.ruleId)).toEqual([
      "everyone-month",
      "opus",
    ]);
  });

  it("treats the same models in another order as the same limit", () => {
    expect(limitKey({ metric: "answers", period: "day", modelIds: ["b", "a"] })).toBe(
      limitKey({ metric: "answers", period: "day", modelIds: ["a", "b"] }),
    );
    expect(limitKey({ metric: "answers", period: "day", modelIds: ["a"] })).not.toBe(
      limitKey({ metric: "answers", period: "day", modelIds: null }),
    );
  });

  it("leaves a group out of a limit it has no rule for, so a lowered limit holds beside it", () => {
    const lowered = rule({ id: "interns", groupId: "interns", amount: 5 });
    expect(effectiveLimits([monthly], [lowered])).toEqual([
      expect.objectContaining({ ruleId: "interns", amount: 5 }),
    ]);
  });

  it("holds the stricter of two of everyone's rules that came to mean the same limit", () => {
    const strict = rule({ id: "a", amount: 3, modelIds: ["m"] });
    const loose = rule({ id: "b", amount: 9, modelIds: ["m"] });
    expect(effectiveLimits([loose, strict], [])).toEqual([
      expect.objectContaining({ ruleId: "a", amount: 3 }),
    ]);
  });

  it("drops a rule whose models are all gone", () => {
    expect(effectiveLimits([rule({ id: "gone", modelIds: [] })], [])).toEqual([]);
  });
});
