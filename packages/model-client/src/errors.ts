import { Duration } from "effect";
import { AiError } from "effect/ai";

export const MODULE = "ModelClient";

/** Every failure this package reports. */
export type ModelClientError = AiError.AiError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export interface ProviderErrorBody {
  readonly message: string | undefined;
  readonly code: string | number | undefined;
}

/**
 * The message and code out of whatever error body a service sends: OpenAI's
 * `{ error: { message } }`, Gemini's array of those, FastAPI's `{ detail }`,
 * a flat `{ message }`, `{ error: "text" }`, or plain text.
 */
export const parseErrorBody = (value: unknown): ProviderErrorBody => {
  const body = typeof value === "string" ? (parseJson(value) ?? value) : value;
  if (typeof body === "string")
    return { message: body.trim().slice(0, 1000) || undefined, code: undefined };
  const first = Array.isArray(body) ? body[0] : body;
  if (!isRecord(first)) return { message: undefined, code: undefined };
  const error = first["error"];
  const source = isRecord(error) ? error : first;
  const message =
    typeof source["message"] === "string"
      ? source["message"]
      : typeof error === "string"
        ? error
        : typeof source["detail"] === "string"
          ? source["detail"]
          : isRecord(source["detail"]) && typeof source["detail"]["message"] === "string"
            ? source["detail"]["message"]
            : undefined;
  const code =
    typeof source["code"] === "string" || typeof source["code"] === "number"
      ? source["code"]
      : typeof source["type"] === "string"
        ? source["type"]
        : undefined;
  return { message: message?.slice(0, 1000), code };
};

/** A rate limit's wait, from Azure's `retry-after-ms` first, then `Retry-After` seconds or date. */
export const retryAfter = (headers: Record<string, string>): Duration.Duration | undefined => {
  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms >= 0) return Duration.millis(ms);
  const value = headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Duration.seconds(seconds);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Duration.millis(Math.max(0, at - Date.now())) : undefined;
};

/**
 * A non-2xx answer as an AiError. The description keeps the provider's own
 * words, since context overflow is only recognisable from them; the request's
 * headers are never included.
 */
export const httpError = (input: {
  readonly method: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly url: string;
}) => {
  const parsed = parseErrorBody(input.body);
  const description = [
    parsed.message ?? `HTTP ${input.status}`,
    typeof parsed.code === "string" && !parsed.message?.includes(parsed.code)
      ? `(${parsed.code})`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const http = {
    request: {
      method: "POST" as const,
      url: input.url,
      urlParams: [],
      headers: {},
    },
    response: { status: input.status, headers: {} },
  };
  const reason =
    input.status === 429 && parsed.code !== "insufficient_quota"
      ? new AiError.RateLimitError({
          http,
          ...(retryAfter(input.headers) ? { retryAfter: retryAfter(input.headers)! } : {}),
        })
      : input.status === 429 || input.status === 402
        ? new AiError.QuotaExhaustedError({ http })
        : AiError.reasonFromHttpStatus({ status: input.status, http, description });
  return AiError.make({ module: MODULE, method: "request", reason });
};

export const invalidOutput = (description: string) =>
  AiError.make({
    module: MODULE,
    method: "stream",
    reason: new AiError.InvalidOutputError({ description }),
  });

export const networkError = (description: string) =>
  AiError.make({
    module: MODULE,
    method: "request",
    reason: new AiError.NetworkError({
      reason: "TransportError",
      request: { method: "POST", url: "", urlParams: [], headers: {} },
      description,
    }),
  });

export const configurationError = (description: string) =>
  AiError.make({
    module: MODULE,
    method: "request",
    reason: new AiError.InvalidUserInputError({ description }),
  });
