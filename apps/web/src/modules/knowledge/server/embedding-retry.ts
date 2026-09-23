import type { ProviderUnreachable } from "~/modules/providers/server/gateway.ts";

export type EmbeddingRetry =
  /** The request itself is wrong; sending it again cannot help. */
  | { readonly kind: "fail" }
  /** The provider is rate limiting the key: stop all embedding for a while. */
  | { readonly kind: "pause"; readonly delayMs: number }
  /** Provider or network trouble: try this page again later. */
  | { readonly kind: "retry"; readonly delayMs: number };

const RATE_LIMIT_FIRST_MS = 5_000;
const RATE_LIMIT_MAX_MS = 5 * 60_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** ±20%, so several waiting workers or instances do not return in step. */
const jitter = (ms: number, random: () => number) => Math.round(ms * (0.8 + random() * 0.4));

/**
 * What to do after an embedding request failed. `attempts` counts this one;
 * `rateLimits` is how many rate limits in a row came before it, which grows
 * the pause when the provider sends no `Retry-After`.
 */
export const embeddingRetry = (
  failure: unknown,
  attempts: number,
  rateLimits: number,
  random: () => number = Math.random,
): EmbeddingRetry => {
  if (!isProviderUnreachable(failure)) return { kind: "fail" };
  const diagnostic = failure.diagnostic;
  if (diagnostic?.kind === "InvalidRequestError") return { kind: "fail" };
  if (diagnostic?.kind === "RateLimitError") {
    // The provider's own figure wins; it knows when the window reopens.
    if (diagnostic.retryAfterMs !== undefined)
      return { kind: "pause", delayMs: Math.min(diagnostic.retryAfterMs, RATE_LIMIT_MAX_MS) };
    return {
      kind: "pause",
      delayMs: jitter(Math.min(RATE_LIMIT_FIRST_MS * 2 ** rateLimits, RATE_LIMIT_MAX_MS), random),
    };
  }
  return {
    kind: "retry",
    delayMs: jitter(
      Math.min(RETRY_FIRST_MS * 4 ** Math.max(0, attempts - 1), RETRY_MAX_MS),
      random,
    ),
  };
};

const isProviderUnreachable = (failure: unknown): failure is ProviderUnreachable =>
  typeof failure === "object" &&
  failure !== null &&
  "_tag" in failure &&
  failure._tag === "ProviderUnreachable";
