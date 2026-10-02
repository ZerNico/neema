import { Clock, Effect, Redacted } from "effect";
import { parseRetryAfter } from "~/server/retry-after.ts";
import type { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  SearchProviderError,
  type SearchFailureReason,
  type SearchHit,
  type SearchProviderSnapshot,
} from "./types.ts";

export const searchFailure = (
  reason: SearchFailureReason,
  message: string,
  retryAfterMs?: number,
) =>
  new SearchProviderError({
    reason,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

/** The usual meaning of a status; adapters classify their own quirks first. */
export const statusFailure = (status: number, detail: string, retryAfter?: number) => {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403)
    return searchFailure("auth", `key rejected (HTTP ${status})${suffix}`);
  if (status === 402)
    return searchFailure("quota", `credits used up (HTTP 402)${suffix}`, retryAfter);
  if (status === 429)
    return searchFailure("rate_limited", `rate limited (HTTP 429)${suffix}`, retryAfter);
  if (status === 408 || status >= 500)
    return searchFailure("unavailable", `HTTP ${status}${suffix}`);
  return searchFailure("rejected", `HTTP ${status}${suffix}`);
};

export interface FailedResponse {
  readonly status: number;
  readonly headers: HttpClientResponse.HttpClientResponse["headers"];
  /** The body as JSON when it parses, else its text. */
  readonly body: unknown;
  /** A short excerpt of the provider's own error message, for the admin and the model. */
  readonly detail: string;
  readonly retryAfterMs: number | undefined;
}

const pickMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["detail", "error", "message", "readableMessage"]) {
    const found = pickMessage(record[key]);
    if (found) return found;
  }
  return undefined;
};

const errorDetail = (body: unknown): string =>
  (pickMessage(body) ?? "").replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * Executes a provider request and returns its JSON body. Every non-200 is read
 * once and handed to `classify`, falling back to `statusFailure`; transport and
 * parse errors are the provider being unavailable.
 */
export const fetchJson = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  classify?: (response: FailedResponse) => SearchProviderError | undefined,
): Effect.Effect<unknown, SearchProviderError> =>
  Effect.gen(function* () {
    const response = yield* http.execute(request);
    if (response.status === 200) return yield* response.json;
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    const failed: FailedResponse = {
      status: response.status,
      headers: response.headers,
      body,
      detail: errorDetail(body),
      retryAfterMs:
        parseRetryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis) ??
        undefined,
    };
    return yield* (
      classify?.(failed) ?? statusFailure(failed.status, failed.detail, failed.retryAfterMs)
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof SearchProviderError ? error : searchFailure("unavailable", String(error)),
      ),
    ),
  );

export const requireSecret = (provider: SearchProviderSnapshot) =>
  provider.secret
    ? Effect.succeed(Redacted.value(provider.secret))
    : Effect.fail(searchFailure("auth", "no API key is stored"));

export const invalidResponse = (error: unknown) =>
  searchFailure("unavailable", `unexpected response: ${String(error).slice(0, 160)}`);

/** Keeps search order, drops repeats of a URL, caps at `max`. */
export const collectHits = (
  items: ReadonlyArray<{
    url: string;
    title: string | null | undefined;
    snippet: string | null | undefined;
  }>,
  max: number,
  extra?: (index: number) => Pick<SearchHit, "engine" | "score">,
): SearchHit[] => {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const [index, item] of items.entries()) {
    const key = item.url.replace(/\/$/, "");
    if (!item.url || seen.has(key)) continue;
    seen.add(key);
    hits.push({
      url: item.url,
      title: item.title || item.url,
      snippet: item.snippet ?? "",
      ...extra?.(index),
    });
    if (hits.length >= max) break;
  }
  return hits;
};
