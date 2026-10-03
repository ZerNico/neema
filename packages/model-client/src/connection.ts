import { Effect, Redacted, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import { httpError, networkError } from "./errors.ts";
import {
  effectiveSettings,
  getPreset,
  resolveBaseUrl,
  type Preset,
  type PresetId,
  type ProviderSettings,
} from "./preset.ts";
import type { ReplayIdentity } from "./replay.ts";

/** A configured provider, resolved: everything a request needs to reach it. */
export interface Connection {
  /** The app's provider id, part of every replay identity. */
  readonly provider: string;
  readonly preset: Preset;
  readonly baseUrl: string;
  readonly apiKey: Redacted.Redacted<string> | string | null;
  readonly settings: Preset["defaults"];
}

export const makeConnection = (input: {
  readonly provider: string;
  readonly preset: PresetId;
  readonly baseUrl: string | null;
  readonly apiKey: Redacted.Redacted<string> | string | null;
  readonly settings?: ProviderSettings | null;
}): Connection | null => {
  const preset = getPreset(input.preset);
  const baseUrl = resolveBaseUrl(preset, input.baseUrl);
  if (!baseUrl) return null;
  return {
    provider: input.provider,
    preset,
    baseUrl,
    apiKey: input.apiKey,
    settings: effectiveSettings(preset, input.settings),
  };
};

/** What one model call asks for, beyond the prompt and tools. */
export interface ModelCall {
  readonly model: string;
  readonly capabilities: {
    readonly reasoning: boolean;
    readonly tools?: boolean;
    readonly vision?: boolean;
    readonly files?: boolean;
    readonly imageOutput?: boolean;
  };
  readonly maxOutputTokens?: number | undefined;
  /** A level the user chose; null or absent sends none and leaves the model's default. */
  readonly reasoningEffort?: string | null | undefined;
  /** Groups requests sharing a prompt prefix, for services that route by it. */
  readonly cacheKey?: string | undefined;
  /** Asks an image-capable model for image output on this call. */
  readonly imageOutput?: boolean | undefined;
}

export const identityOf = (connection: Connection, model: string): ReplayIdentity => ({
  provider: connection.provider,
  baseUrl: connection.baseUrl,
  format: connection.settings.format,
  model,
});

const keyValue = (key: Connection["apiKey"]) =>
  key === null ? "" : Redacted.isRedacted(key) ? Redacted.value(key) : key;

/** The headers that authenticate a request, per the preset or the admin's header name. */
export const authHeaders = (connection: Connection): Record<string, string> => {
  const key = keyValue(connection.apiKey).trim();
  if (!key) return {};
  const header = connection.settings.keyHeader;
  return header ? { [header]: key } : { authorization: `Bearer ${key}` };
};

export const endpoint = (connection: Connection, path: string) =>
  `${connection.baseUrl.replace(/\/+$/, "")}${path}`;

const ERROR_BODY_LIMIT = 64 * 1024;

const lowercase = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

/** POSTs a JSON body; a non-2xx answer becomes a classified AiError with the provider's words. */
export const postJson = (connection: Connection, path: string, body: unknown) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = endpoint(connection, path);
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        accept: "text/event-stream, application/json",
        ...authHeaders(connection),
      }),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => networkError("The provider could not be reached")));
    if (response.status >= 200 && response.status < 300) return response;
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(
      httpError({
        method: "POST",
        status: response.status,
        headers: lowercase(response.headers),
        body: text.slice(0, ERROR_BODY_LIMIT),
        url,
      }),
    );
  });

export const responseBytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.mapError(() => networkError("The connection to the provider was interrupted")),
  );
