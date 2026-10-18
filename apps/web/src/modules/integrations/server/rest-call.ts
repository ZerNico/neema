import { Duration, Effect } from "effect";
import { readCapped } from "~/modules/tools/server/public-fetch.ts";
import { IntegrationAuthFailed, IntegrationRequestFailed } from "../errors.ts";
import type { Credential } from "./adapter.ts";

const TIMEOUT_MS = 20_000;
const MAX_RETRY_WAIT_MS = 10_000;
/** More than any one page, message or issue a service returns, far less than memory. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const failed = (status: number | null, message: string) =>
  new IntegrationRequestFailed({ status, message });

const retryAfter = (response: Response) => {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
};

/**
 * One JSON request to a service's fixed origin. A redirect is refused rather
 * than followed with the credential attached, a throttled request is retried
 * once when `retry` says it was not processed, and the body read is capped.
 */
export const restCall = <A>(input: {
  /** As a person reads it: "Jira", "Outlook". */
  readonly service: string;
  readonly integrationId: string;
  readonly credential: Credential;
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly retry: (status: number) => boolean;
  readonly reason: (status: number, json: unknown) => string;
}): Effect.Effect<A, IntegrationAuthFailed | IntegrationRequestFailed> =>
  Effect.gen(function* () {
    const once = Effect.tryPromise({
      try: (signal) =>
        fetch(input.url, {
          method: input.method,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          headers: {
            accept: "application/json",
            authorization: input.authorization,
            ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
            ...input.headers,
          },
          ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        }),
      catch: () => failed(null, `${input.service} could not be reached.`),
    });
    let response = yield* once;
    const wait = retryAfter(response);
    if (input.retry(response.status) && wait <= MAX_RETRY_WAIT_MS) {
      // Let the first answer's connection go before asking again.
      void response.body?.cancel();
      yield* Effect.sleep(Duration.millis(wait));
      response = yield* once;
    }
    if (response.status === 401)
      return yield* new IntegrationAuthFailed({
        integrationId: input.integrationId,
        ...(input.credential.identity ? { credential: input.credential.identity } : {}),
      });
    // Updates and sends answer 202 or 204 with no body.
    const read = yield* readCapped(response.body, MAX_BODY_BYTES).pipe(
      Effect.mapError(() =>
        failed(response.status, `${input.service} answered ${response.status} without a body.`),
      ),
    );
    if (read.truncated)
      return yield* failed(response.status, `${input.service} answered with too much to read.`);
    const raw = new TextDecoder().decode(read.data);
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        if (response.ok)
          return yield* failed(
            response.status,
            `${input.service} answered ${response.status} without JSON.`,
          );
      }
    }
    if (!response.ok) return yield* failed(response.status, input.reason(response.status, json));
    return json as A;
  });

/** A path with its query string, each value encoded once. */
export const queryPath = (path: string, query: Record<string, string | number | undefined>) => {
  const params = Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
  return params.length ? `${path}?${params.join("&")}` : path;
};
