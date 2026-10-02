import { describe, expect, it } from "vitest";
import { ProviderUnreachable } from "~/modules/providers/server/gateway.ts";
import { parseRetryAfter } from "~/server/retry-after.ts";
import { embeddingRetry } from "./embedding-retry.ts";

const failure = (diagnostic?: ProviderUnreachable["diagnostic"]) =>
  new ProviderUnreachable({
    providerId: "p",
    message: "failed",
    ...(diagnostic ? { diagnostic } : {}),
  });
const middle = () => 0.5;

describe("embedding retry", () => {
  it("pauses for exactly what the provider asked after a rate limit", () => {
    expect(
      embeddingRetry(failure({ kind: "RateLimitError", status: 429, retryAfterMs: 12_000 }), 1, 0),
    ).toEqual({ kind: "pause", delayMs: 12_000 });
  });

  it("backs off without Retry-After, doubling up to five minutes", () => {
    const pause = (rateLimits: number) =>
      embeddingRetry(failure({ kind: "RateLimitError", status: 429 }), 1, rateLimits, middle);
    expect(pause(0)).toEqual({ kind: "pause", delayMs: 5_000 });
    expect(pause(1)).toEqual({ kind: "pause", delayMs: 10_000 });
    expect(pause(20)).toEqual({ kind: "pause", delayMs: 300_000 });
  });

  it("retries provider and network trouble later, longer each attempt", () => {
    const retry = (attempts: number) =>
      embeddingRetry(failure({ kind: "InternalProviderError", status: 503 }), attempts, 0, middle);
    expect(retry(1)).toEqual({ kind: "retry", delayMs: 30_000 });
    expect(retry(2)).toEqual({ kind: "retry", delayMs: 120_000 });
    expect(embeddingRetry(failure({ kind: "NetworkError" }), 1, 0, middle).kind).toBe("retry");
    expect(embeddingRetry(failure({ kind: "AuthenticationError" }), 1, 0, middle).kind).toBe(
      "retry",
    );
  });

  it("fails a request that would fail the same way again", () => {
    expect(embeddingRetry(failure({ kind: "InvalidRequestError", status: 400 }), 1, 0)).toEqual({
      kind: "fail",
    });
    expect(embeddingRetry(new Error("not a provider failure"), 1, 0)).toEqual({ kind: "fail" });
  });

  it("reads Retry-After as seconds or as a date", () => {
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 24 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });
});
