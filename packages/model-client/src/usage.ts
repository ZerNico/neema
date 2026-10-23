import type { Response } from "effect/ai";

type UsageEncoded = typeof Response.Usage.Encoded;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** No usage reported: every count unknown, which is not the same as zero. */
export const unknownUsage = (): UsageEncoded => ({
  inputTokens: {
    uncached: undefined,
    total: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

/**
 * Normalises the usage object of either wire format, in every dialect seen in
 * the wild, to Effect's shape: the input total includes cached reads and
 * writes. Services report those either inside the prompt count (OpenAI,
 * OpenRouter, DeepSeek) or beside it (Anthropic-style fields through relays).
 */
export const normalizeUsage = (raw: unknown): { usage: UsageEncoded; cost?: number } | null => {
  const usage = object(raw);
  if (!usage) return null;
  const promptDetails =
    object(usage["prompt_tokens_details"]) ?? object(usage["input_tokens_details"]);
  const completionDetails =
    object(usage["completion_tokens_details"]) ?? object(usage["output_tokens_details"]);

  const prompt = count(usage["prompt_tokens"]) ?? count(usage["input_tokens"]);
  const completion = count(usage["completion_tokens"]) ?? count(usage["output_tokens"]);
  const cacheRead =
    count(promptDetails?.["cached_tokens"]) ??
    count(usage["prompt_cache_hit_tokens"]) ??
    count(usage["cache_read_input_tokens"]) ??
    count(usage["cached_tokens"]);
  const cacheWrite =
    count(promptDetails?.["cache_write_tokens"]) ??
    count(promptDetails?.["cache_creation_tokens"]) ??
    count(usage["cache_creation_input_tokens"]);
  const reasoning =
    count(completionDetails?.["reasoning_tokens"]) ?? count(usage["reasoning_tokens"]);

  if (prompt === undefined && completion === undefined) return null;

  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  // Anthropic's own fields sit beside an `input_tokens` that excludes them;
  // OpenAI-style details sit inside the prompt count. A relay mixing names is
  // known to be additive only when the cache counts exceed the prompt.
  const anthropicNative =
    !promptDetails &&
    usage["prompt_tokens"] === undefined &&
    (usage["cache_read_input_tokens"] !== undefined ||
      usage["cache_creation_input_tokens"] !== undefined);
  const inputTotal =
    prompt === undefined
      ? undefined
      : anthropicNative || cached > prompt
        ? prompt + cached
        : prompt;
  const outputTotal =
    completion === undefined
      ? undefined
      : (reasoning ?? 0) > completion
        ? completion + (reasoning ?? 0)
        : completion;

  const cost = usage["cost"];
  return {
    usage: {
      inputTokens: {
        total: inputTotal,
        cacheRead,
        cacheWrite,
        uncached: inputTotal === undefined ? undefined : Math.max(0, inputTotal - cached),
      },
      outputTokens: {
        total: outputTotal,
        reasoning,
        text: outputTotal === undefined ? undefined : Math.max(0, outputTotal - (reasoning ?? 0)),
      },
    },
    // A reported zero is a statement (free model), kept as such.
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
  };
};
