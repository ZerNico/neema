import { describe, expect, it } from "vitest";
import {
  ResearchBudget,
  RESEARCH_LIMITS,
  researchOutputCaps,
  researchPhaseSpecs,
  validateResearchCitations,
} from "./budget.ts";

const specs = researchPhaseSpecs(researchOutputCaps(undefined), 2048);

describe("research execution admission", () => {
  it.each([8000, 30000, 200000])(
    "admits exactly worker + pending reports at the %i context boundary",
    (context) => {
      const caps = researchOutputCaps(context);
      const budget = new ResearchBudget(0, () => 0, caps);
      const phases = researchPhaseSpecs(caps, 2048);
      expect(budget.admitTask()).toBe(true);
      const required = caps.ordinary + 2 * caps.report;
      budget.reservedOutput = RESEARCH_LIMITS.outputTokens - required + 1;
      expect(budget.admitTask()).toBe(false);
      expect(budget.pendingReports).toBe(1);
      budget.reservedOutput--;
      expect(budget.admitTask()).toBe(true);
      expect(budget.reserve(phases.worker)?.maxOutputTokens).toBe(caps.ordinary);
      expect(budget.reserve(phases.worker)).toBeNull();
      expect(budget.reserve(phases.report)?.maxOutputTokens).toBe(caps.report);
      expect(budget.reserve(phases.report)?.maxOutputTokens).toBe(caps.report);
      expect(budget.reservedOutput).toBe(RESEARCH_LIMITS.outputTokens);
    },
  );

  it("reserves each phase's actual output, including compaction", () => {
    for (const spec of Object.values(specs)) {
      const budget = new ResearchBudget(0, () => 0);
      if (spec.phase === "report") budget.admitTask();
      expect(budget.reserve(spec)?.maxOutputTokens).toBe(spec.maxOutputTokens);
      expect(budget.reservedOutput).toBe(spec.maxOutputTokens);
    }
  });
  it("reserves one report for every admitted task", () => {
    const budget = new ResearchBudget(0, () => 0);
    for (let task = 0; task < RESEARCH_LIMITS.tasks; task++) expect(budget.admitTask()).toBe(true);
    expect(budget.admitTask()).toBe(false);
    let explorationCalls = 0;
    while (budget.reserve(specs.worker)) explorationCalls++;
    expect(explorationCalls).toBeGreaterThan(0);
    for (let task = 0; task < RESEARCH_LIMITS.tasks; task++)
      expect(budget.reserve(specs.report)).not.toBeNull();
    expect(budget.calls).toBeLessThanOrEqual(RESEARCH_LIMITS.calls);
    expect(budget.reservedOutput).toBeLessThanOrEqual(RESEARCH_LIMITS.outputTokens);
  });
  it("counts no-op turns even when output reservations are released", () => {
    const budget = new ResearchBudget(0, () => 0);
    for (let i = 0; i < RESEARCH_LIMITS.calls; i++) {
      const reservation = budget.reserve(specs.coordinator)!;
      expect(reservation).not.toBeNull();
      budget.finish(reservation, 0);
    }
    expect(budget.reserve(specs.worker)).toBeNull();
    expect(budget.calls).toBe(RESEARCH_LIMITS.calls);
  });
  it("admits an ordinary call that exactly fits the remaining output", () => {
    const budget = new ResearchBudget(0, () => 0);
    budget.reservedOutput = RESEARCH_LIMITS.outputTokens - specs.coordinator.maxOutputTokens;
    expect(budget.reserve(specs.coordinator)).not.toBeNull();
    expect(budget.reservedOutput).toBe(RESEARCH_LIMITS.outputTokens);
    expect(budget.reserve(specs.coordinator)).toBeNull();
  });
  it("keeps the final model calls for admitted task reports", () => {
    const budget = new ResearchBudget(0, () => 0);
    budget.calls = RESEARCH_LIMITS.calls - 2;
    expect(budget.admitTask()).toBe(true);
    expect(budget.admitTask()).toBe(false);
    const worker = budget.reserve(specs.worker)!;
    expect(worker).not.toBeNull();
    budget.finish(worker, 0);
    expect(budget.reserve(specs.coordinator)).toBeNull();
    expect(budget.reserve(specs.compaction)).toBeNull();
    expect(budget.reserve(specs.report)).not.toBeNull();
    expect(budget.calls).toBe(RESEARCH_LIMITS.calls);
    expect(budget.pendingReports).toBe(0);
  });
  it("retains conservative output reservations when finish usage is absent or invalid", () => {
    const budget = new ResearchBudget(0, () => 0);
    const reservation = budget.reserve(specs.worker)!;
    for (const usage of [undefined, -1, NaN, Infinity, 5000]) budget.finish(reservation, usage);
    expect(budget.reservedOutput).toBe(4096);
  });
  it("counts individual batched targets and refuses exploration after the deadline", () => {
    let now = 0;
    const budget = new ResearchBudget(0, () => now);
    while (budget.remaining().searches > 0)
      expect(budget.admitWeb("search", Math.min(3, budget.remaining().searches))).toBe(true);
    expect(budget.admitTask()).toBe(true);
    expect(budget.admitWeb("read", RESEARCH_LIMITS.reads)).toBe(true);
    // The first refusal ends exploration: dispatching or looping past it would
    // only spend model calls on tools that must refuse.
    expect(budget.admitWeb("search", 1)).toBe(false);
    expect(budget.webAvailable).toBe(false);
    expect(budget.admitTask()).toBe(false);
    expect(budget.admitWeb("read", 1)).toBe(false);
    now = RESEARCH_LIMITS.explorationMs;
    expect(budget.reserve(specs.worker)).toBeNull();
    expect(budget.admitWeb("read", 0)).toBe(false);
    expect(budget.reserve(specs.report)).not.toBeNull();
  });
  it.each([12, 80, 120])(
    "uses the %i-query cap for admission, remaining allowance and headroom",
    (maxSearches) => {
      const budget = new ResearchBudget(0, () => 0, undefined, maxSearches);
      expect(budget.remaining().searches).toBe(maxSearches);
      expect(budget.headroom).toBe(1);
      expect(budget.admitTask()).toBe(true);
      while (budget.remaining().searches > 2)
        expect(budget.admitWeb("search", Math.min(3, budget.remaining().searches - 2))).toBe(true);
      expect(budget.remaining().searches).toBe(2);
      expect(budget.headroom).toBeCloseTo(2 / maxSearches);
      expect(budget.webAvailable).toBe(true);
      expect(budget.admitWeb("search", 3)).toBe(false);
      expect(budget.searches).toBe(maxSearches - 2);
      expect(budget.webAvailable).toBe(false);
      expect(budget.canDispatch).toBe(false);
      expect(budget.remaining().reads).toBe(RESEARCH_LIMITS.reads);
      expect(budget.reserve(specs.report)).not.toBeNull();
    },
  );

  it("shrinks its guidance from room to investigate down to wrap up", () => {
    let now = 0;
    const budget = new ResearchBudget(0, () => now);
    expect(budget.headroom).toBe(1);
    expect(budget.remaining()).toMatchObject({
      searches: RESEARCH_LIMITS.searches,
      reads: RESEARCH_LIMITS.reads,
      tasks: RESEARCH_LIMITS.tasks,
    });
    budget.admitWeb("search", RESEARCH_LIMITS.searches / 2);
    expect(budget.headroom).toBeCloseTo(0.5);
    // Elapsed time tightens the same guidance even with every target unspent.
    now = RESEARCH_LIMITS.explorationMs * 0.9;
    expect(budget.headroom).toBeCloseTo(0.1);
    expect(budget.remaining().minutes).toBeLessThanOrEqual(2);
  });

  it("sizes output caps from the model context and reserves what it will request", () => {
    const small = researchOutputCaps(30_000);
    const large = researchOutputCaps(200_000);
    const unknown = researchOutputCaps(null);
    expect(researchOutputCaps(8000)).toEqual({ ordinary: 1600, report: 1600 });
    expect(small.report).toBe(6000);
    expect(small.report).toBeLessThan(unknown.report);
    expect(large.report).toBe(RESEARCH_LIMITS.reportOutput);
    for (const caps of [small, large, unknown]) {
      expect(caps.ordinary).toBeLessThanOrEqual(RESEARCH_LIMITS.ordinaryOutput);
      expect(caps.report).toBeLessThanOrEqual(RESEARCH_LIMITS.reportOutput);
      const phases = researchPhaseSpecs(caps, 2048);
      expect(phases.worker.maxOutputTokens).toBe(caps.ordinary);
      expect(phases.report.maxOutputTokens).toBe(caps.report);
    }
    // Reservations follow the resolved caps, not the ceilings.
    const budget = new ResearchBudget(0, () => 0, small);
    const phases = researchPhaseSpecs(small, 2048);
    expect(budget.admitTask()).toBe(true);
    expect(budget.reserve(phases.worker)).toMatchObject({ maxOutputTokens: small.ordinary });
    // A report is only reservable against an admitted task.
    expect(budget.reserve(phases.report)).toMatchObject({ maxOutputTokens: small.report });
  });

  it("latches exploration off after consecutive failed searches, not scattered ones", () => {
    const budget = new ResearchBudget(0, () => 0);
    for (let i = 0; i < RESEARCH_LIMITS.searchOutageThreshold - 1; i++) budget.observeSearch(false);
    budget.observeSearch(true);
    expect(budget.webAvailable).toBe(true);
    for (let i = 0; i < RESEARCH_LIMITS.searchOutageThreshold; i++) budget.observeSearch(false);
    expect(budget.searchUnavailable).toBe(true);
    expect(budget.webAvailable).toBe(false);
    expect(budget.canDispatch).toBe(false);
  });

  it("rejects invented citation numbers and provider-written definitions", () => {
    expect(
      validateResearchCitations(
        "Evidence[^1], forged[^9].\n[^1]: https://forged.example",
        new Set([1]),
      ),
    ).toEqual({ text: "Evidence[^1], forged[unverified source].\n", invalid: true });
    // Plain [N] that names a registered source becomes a marker; a number that
    // is not a source, or a markdown link label, stays as written.
    expect(
      validateResearchCitations("A[2][3], list [4] and [link](x)[1].", new Set([1, 2])),
    ).toEqual({ text: "A[^2][3], list [4] and [link](x)[^1].", invalid: false });
  });
});
