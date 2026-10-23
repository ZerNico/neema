import type { Response } from "effect/ai";
import type { ModelPricing } from "~/modules/providers/model-config.ts";

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

const noTokens = (): TokenCounts => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
});

const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/**
 * Accumulated across the model turns of one generation attempt, the ledger
 * row's numeric half. Input counts include cached reads and writes.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Null until a turn reports cache writes: most services never say. */
  cacheWriteTokens: number | null;
  reasoningTokens: number;
  /** Sum of provider-reported billed cost; null until any turn reports one. */
  providerCost: number | null;
  /** The tokens of the turns whose cost the provider reported, so the rest can be priced. */
  providerCovered: TokenCounts;
  /** Turns that reported neither usage nor a cost: no rate can price what was not counted. */
  unmeasuredTurns: number;
  /** Whether any finish part carried usage at all. */
  sawUsage: boolean;
}

export const emptyUsageTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: null,
  reasoningTokens: 0,
  providerCost: null,
  providerCovered: noTokens(),
  unmeasuredTurns: 0,
  sawUsage: false,
});

/** The billed cost in USD a provider reported for one model turn, from the model client's finish metadata. */
export const providerCostOf = (metadata: unknown): number | null => {
  const own = (metadata as { modelClient?: { cost?: unknown } } | null | undefined)?.modelClient;
  return typeof own?.cost === "number" && Number.isFinite(own.cost) ? own.cost : null;
};

export const addFinishUsage = (
  totals: UsageTotals,
  finish: { usage: Response.Usage; metadata?: unknown },
): void => {
  const { inputTokens, outputTokens } = finish.usage;
  const measured = inputTokens.total !== undefined || outputTokens.total !== undefined;
  if (measured) totals.sawUsage = true;
  const turn: TokenCounts = {
    inputTokens: inputTokens.total ?? 0,
    outputTokens: outputTokens.total ?? 0,
    cachedInputTokens: inputTokens.cacheRead ?? 0,
    cacheWriteTokens: inputTokens.cacheWrite ?? 0,
  };
  totals.inputTokens += turn.inputTokens;
  totals.outputTokens += turn.outputTokens;
  totals.cachedInputTokens += turn.cachedInputTokens;
  if (inputTokens.cacheWrite !== undefined)
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + turn.cacheWriteTokens;
  totals.reasoningTokens += outputTokens.reasoning ?? 0;
  const cost = providerCostOf(finish.metadata);
  if (cost === null) {
    if (!measured) totals.unmeasuredTurns += 1;
    return;
  }
  totals.providerCost = (totals.providerCost ?? 0) + cost;
  totals.providerCovered = addTokens(totals.providerCovered, turn);
};

/** Adds one attempt's totals to another's, keeping which tokens a reported cost covered. */
export const mergeUsageTotals = (into: UsageTotals, from: UsageTotals): void => {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  if (from.cacheWriteTokens !== null)
    into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + from.cacheWriteTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.sawUsage ||= from.sawUsage;
  if (from.providerCost !== null) into.providerCost = (into.providerCost ?? 0) + from.providerCost;
  into.providerCovered = addTokens(into.providerCovered, from.providerCovered);
  into.unmeasuredTurns += from.unmeasuredTurns;
};

/**
 * What tokens cost at the model's rates. Cached reads and cache writes use
 * their own rates when the model has them and the input rate otherwise.
 */
const priceTokens = (tokens: TokenCounts, pricing: ModelPricing) => {
  const uncached = Math.max(
    0,
    tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheWriteTokens,
  );
  return (
    (uncached * pricing.input +
      tokens.cachedInputTokens * (pricing.cacheRead ?? pricing.input) +
      tokens.cacheWriteTokens * (pricing.cacheWrite ?? pricing.input) +
      tokens.outputTokens * (pricing.output ?? 0)) /
    1_000_000
  );
};

/**
 * Provider-reported cost wins, since it reflects what was actually billed, cache
 * discounts included. Turns it did not cover are priced from the model's rates;
 * without either the cost is honestly unknown, never a partial sum. A sum that
 * is partly estimated is labelled as pricing.
 */
export const resolveCost = (
  totals: UsageTotals,
  pricing: ModelPricing | null | undefined,
  output: "text" | "images" | "incomplete-images" = "text",
): { cost: number | null; costSource: "provider" | "pricing" | null } => {
  if (output === "incomplete-images" || totals.unmeasuredTurns > 0)
    return { cost: null, costSource: null };
  const covered = totals.providerCovered;
  const rest: TokenCounts = {
    inputTokens: Math.max(0, totals.inputTokens - covered.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens - covered.outputTokens),
    cachedInputTokens: Math.max(0, totals.cachedInputTokens - covered.cachedInputTokens),
    cacheWriteTokens: Math.max(0, (totals.cacheWriteTokens ?? 0) - covered.cacheWriteTokens),
  };
  const uncovered = rest.inputTokens > 0 || rest.outputTokens > 0;
  const priceable =
    output === "text" && pricing && (rest.outputTokens === 0 || pricing.output !== null);
  if (totals.providerCost !== null) {
    if (!uncovered) return { cost: totals.providerCost, costSource: "provider" };
    if (priceable)
      return { cost: totals.providerCost + priceTokens(rest, pricing), costSource: "pricing" };
    // A reported cost for some rounds is not the attempt's cost.
    return { cost: null, costSource: null };
  }
  if (uncovered && priceable) return { cost: priceTokens(rest, pricing), costSource: "pricing" };
  return { cost: null, costSource: null };
};
