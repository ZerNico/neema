import type { Response } from "effect/unstable/ai";

// Accumulated across the model turns of one generation attempt — the ledger
// row's numeric half.
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  /** Sum of provider-reported billed cost; null until any turn reports one. */
  providerCost: number | null;
  /** Whether any finish part carried usage at all. */
  sawUsage: boolean;
}

export const emptyUsageTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  providerCost: null,
  sawUsage: false,
});

// Finish metadata is provider-augmented and untyped here; OpenRouter attaches
// its raw usage object — including the actual billed `cost` in USD — under
// metadata.openrouter.usage (see @effect/ai-openrouter OpenRouterLanguageModel).
export const providerCostOf = (metadata: unknown): number | null => {
  const usage = (metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
    ?.openrouter?.usage;
  return typeof usage?.cost === "number" ? usage.cost : null;
};

export const addFinishUsage = (
  totals: UsageTotals,
  finish: { usage: Response.Usage; metadata?: unknown },
): void => {
  const { inputTokens, outputTokens } = finish.usage;
  if (inputTokens.total !== undefined || outputTokens.total !== undefined) totals.sawUsage = true;
  totals.inputTokens += inputTokens.total ?? 0;
  totals.outputTokens += outputTokens.total ?? 0;
  totals.cachedInputTokens += inputTokens.cacheRead ?? 0;
  totals.reasoningTokens += outputTokens.reasoning ?? 0;
  const cost = providerCostOf(finish.metadata);
  if (cost !== null) totals.providerCost = (totals.providerCost ?? 0) + cost;
};

/**
 * Provider-reported cost wins — it reflects what was actually billed, cache
 * discounts included. Model pricing (USD per 1M tokens) is the fallback;
 * without either the cost is honestly unknown.
 */
export const resolveCost = (
  totals: UsageTotals,
  pricing: { input: number; output: number | null } | null | undefined,
  output: "text" | "images" | "incomplete-images" = "text",
): { cost: number | null; costSource: "provider" | "pricing" | null } => {
  if (output === "incomplete-images") return { cost: null, costSource: null };
  if (totals.providerCost !== null) return { cost: totals.providerCost, costSource: "provider" };
  if (
    output === "text" &&
    pricing &&
    (totals.inputTokens > 0 || totals.outputTokens > 0) &&
    (totals.outputTokens === 0 || pricing.output !== null)
  ) {
    return {
      cost:
        (totals.inputTokens * pricing.input + totals.outputTokens * (pricing.output ?? 0)) /
        1_000_000,
      costSource: "pricing",
    };
  }
  return { cost: null, costSource: null };
};
