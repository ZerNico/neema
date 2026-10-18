import { Clock, Effect, Redacted, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import { configurationError, httpError, invalidOutput, networkError } from "./errors.ts";
import {
  effectiveSettings,
  getPreset,
  resolveBaseUrl,
  type Preset,
  type PresetId,
  type ProviderSettings,
  type WireFormat,
} from "./preset.ts";
import type { ReplayIdentity } from "./replay.ts";
import { amzDate, authorization, bedrockScope, sha256Hex } from "./sigv4.ts";
import { sseEvents } from "./sse.ts";

type Secret = Redacted.Redacted<string> | string;

/** What proves a request is the provider's own: a key, or AWS access keys that sign it. */
export type Credentials =
  | { readonly kind: "key"; readonly key: Secret }
  | { readonly kind: "aws"; readonly accessKeyId: string; readonly secretAccessKey: Secret };

/** A configured provider, resolved: everything a request needs to reach it. */
export interface Connection {
  /** The app's provider id, part of every replay identity. */
  readonly provider: string;
  readonly preset: Preset;
  readonly baseUrl: string;
  readonly credentials: Credentials | null;
  readonly settings: Preset["defaults"];
}

export const makeConnection = (input: {
  readonly provider: string;
  readonly preset: PresetId;
  readonly baseUrl: string | null;
  readonly credentials: Credentials | null;
  readonly settings?: ProviderSettings | null;
}): Connection | null => {
  const preset = getPreset(input.preset);
  const baseUrl = resolveBaseUrl(preset, input.baseUrl);
  if (!baseUrl) return null;
  return {
    provider: input.provider,
    preset,
    baseUrl,
    credentials: input.credentials,
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
  /** The model's own API, where the preset lets each model choose. */
  readonly format?: WireFormat | null | undefined;
  /** Runs once when the model refused Responses and the call moved to Chat Completions. */
  readonly onChatFallback?: Effect.Effect<void> | undefined;
}

export const identityOf = (connection: Connection, model: string): ReplayIdentity => ({
  provider: connection.provider,
  baseUrl: connection.baseUrl,
  format: connection.settings.format,
  model,
});

const reveal = (secret: Secret) => (Redacted.isRedacted(secret) ? Redacted.value(secret) : secret);

/**
 * The headers that authenticate one request: the key in the preset's or the
 * admin's header, or a SigV4 signature over these exact bytes.
 */
export const authenticate = (
  connection: Connection,
  request: { readonly method: string; readonly url: string; readonly body: string },
) =>
  Effect.gen(function* () {
    const credentials = connection.credentials;
    if (credentials?.kind !== "aws") {
      const key = credentials ? reveal(credentials.key).trim() : "";
      if (!key) return {};
      const header = connection.settings.keyHeader;
      return header ? { [header]: key } : { authorization: `Bearer ${key}` };
    }
    const url = new URL(request.url);
    const scope = bedrockScope(url);
    if (!scope)
      return yield* Effect.fail(
        configurationError(`AWS access keys sign only Bedrock endpoints, not ${url.host}.`),
      );
    const date = new Date(yield* Clock.currentTimeMillis);
    const payloadHash = yield* Effect.promise(() => sha256Hex(request.body));
    const headers = { "x-amz-date": amzDate(date), "x-amz-content-sha256": payloadHash };
    const signed = yield* Effect.promise(() =>
      authorization({
        method: request.method,
        url,
        headers,
        payloadHash,
        ...scope,
        keys: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: reveal(credentials.secretAccessKey),
        },
        date,
      }),
    );
    return { ...headers, authorization: signed };
  });

/** A JSON POST serialised once, so a signature covers the bytes that go out. */
export const jsonRequest = (connection: Connection, url: string, body: unknown) =>
  Effect.gen(function* () {
    const text = JSON.stringify(body);
    const headers = yield* authenticate(connection, { method: "POST", url, body: text });
    return HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(text, "application/json"),
    );
  });

export const endpoint = (connection: Connection, path: string) =>
  `${connection.baseUrl.replace(/\/+$/, "")}${path}`;

const ERROR_BODY_LIMIT = 64 * 1024;

const lowercase = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

/** POSTs a JSON body; a non-2xx answer becomes a classified AiError with the provider's words. */
export const postJson = (
  connection: Connection,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = /^https?:\/\//.test(path) ? path : endpoint(connection, path);
    const request = (yield* jsonRequest(connection, url, body)).pipe(
      HttpClientRequest.setHeaders({ accept: "text/event-stream, application/json", ...headers }),
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

/**
 * A wire format's stream: each event through its decoder, then the decoder's
 * end, stopping at the one `finish`. A stream that ends without one fails in `end`.
 */
export const decodeEvents = <A extends { readonly type: string }, E, R>(
  response: HttpClientResponse.HttpClientResponse,
  decoder: {
    readonly event: (data: string) => Effect.Effect<Iterable<A>, E, R>;
    readonly end: Effect.Effect<Iterable<A>, E, R>;
  },
) =>
  sseEvents(responseBytes(response), () =>
    invalidOutput("The provider sent an event larger than allowed"),
  ).pipe(
    Stream.mapEffect((event) => decoder.event(event.data)),
    Stream.concat(Stream.fromEffect(decoder.end)),
    Stream.flattenIterable,
    Stream.takeUntil((part) => part.type === "finish"),
  );
