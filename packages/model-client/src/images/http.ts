import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import { authenticate, jsonRequest, responseBytes, type Connection } from "../connection.ts";
import { httpError, invalidOutput, networkError, parseErrorBody } from "../errors.ts";
import { sseEvents } from "../sse.ts";
import { MAX_BASE64_LENGTH } from "./bytes.ts";

type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const str = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

export const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const ERROR_BODY_LIMIT = 64 * 1024;

/** What came back: the parsed body, or the provider's refusal in its own words. */
export type Reply = { readonly kind: "json"; readonly value: Json } | Refusal;
export interface Refusal {
  readonly kind: "refused";
  readonly message: string;
}

/**
 * Reads a body until it ends or passes `limit`, whichever is first, so a huge
 * answer is never held whole. `over` says the body went past the limit.
 */
const readUpTo = (response: HttpClientResponse.HttpClientResponse, limit: number) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;
    yield* responseBytes(response).pipe(
      Stream.takeWhile(() => total <= limit),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          total += chunk.byteLength;
          chunks.push(chunk);
        }),
      ),
    );
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: bytes.subarray(0, limit), over: total > limit };
  });

const lowercase = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

/**
 * POSTs one image request, JSON or multipart. A non-2xx answer is an AiError
 * unless `refusal` reads it as a content refusal; the body is read up to a cap
 * sized for `images` returned images.
 */
type Request = {
  readonly url: string;
  readonly body: Json | FormData;
  readonly images: number;
  readonly refusal?: (status: number, body: string) => string | undefined;
};

/** Sends one request; a 2xx response comes back unread, anything else as a refusal or an error. */
const send = (connection: Connection, input: Request, accept: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const request =
      input.body instanceof FormData
        ? HttpClientRequest.post(input.url).pipe(
            HttpClientRequest.setHeaders(
              yield* authenticate(connection, { method: "POST", url: input.url, body: "" }),
            ),
            HttpClientRequest.bodyFormData(input.body),
          )
        : yield* jsonRequest(connection, input.url, input.body);
    const response = yield* http
      .execute(request.pipe(HttpClientRequest.setHeader("accept", accept)))
      .pipe(Effect.mapError(() => networkError("The image provider could not be reached")));
    if (response.status < 200 || response.status >= 300) {
      const text = yield* readUpTo(response, ERROR_BODY_LIMIT).pipe(
        Effect.map(({ bytes }) => new TextDecoder().decode(bytes)),
        Effect.orElseSucceed(() => ""),
      );
      const message = input.refusal?.(response.status, text);
      if (message) return { kind: "refused", message } satisfies Refusal;
      return yield* Effect.fail(
        httpError({
          method: "POST",
          status: response.status,
          headers: lowercase(response.headers),
          body: text,
          url: input.url,
        }),
      );
    }
    return { kind: "response", response } as const;
  });

/** A 2xx body read as one JSON object, bounded by the images it may carry. */
const readJson = (response: HttpClientResponse.HttpClientResponse, images: number) =>
  Effect.gen(function* () {
    const { bytes, over } = yield* readUpTo(response, images * MAX_BASE64_LENGTH + 1024 * 1024);
    if (over) return yield* Effect.fail(invalidOutput("The image provider's answer is too large"));
    const value = yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
      catch: () => invalidOutput("The image provider's answer is not JSON"),
    });
    if (!isRecord(value))
      return yield* Effect.fail(invalidOutput("The image provider's answer is not a JSON object"));
    return { kind: "json", value } satisfies Reply;
  });

export const post = (connection: Connection, input: Request) =>
  Effect.gen(function* () {
    const sent = yield* send(connection, input, "application/json");
    if (sent.kind === "refused") return sent satisfies Reply;
    return yield* readJson(sent.response, input.images);
  });

/**
 * The same request answered as server-sent events: each event's JSON data in
 * order, or the refusal. One event is bounded by an image's size. A gateway
 * that ignores `stream` and answers JSON is read as `post` would.
 */
export const postEvents = (connection: Connection, input: Request) =>
  Effect.gen(function* () {
    const sent = yield* send(connection, input, "text/event-stream");
    if (sent.kind === "refused") return sent;
    const type = lowercase(sent.response.headers)["content-type"] ?? "";
    if (type.includes("application/json")) return yield* readJson(sent.response, input.images);
    const events = sseEvents(responseBytes(sent.response), () =>
      invalidOutput("The image provider's event is too large"),
    ).pipe(
      Stream.filter((event) => event.data !== "" && event.data !== "[DONE]"),
      Stream.mapEffect((event) =>
        Effect.try({
          try: (): unknown => JSON.parse(event.data),
          catch: () => invalidOutput("The image provider sent an event that is not JSON"),
        }),
      ),
      Stream.filter(isRecord),
    );
    return { kind: "events", events } as const;
  });

/** Reads a moderation block by its error code, the stable discriminator OpenAI documents. */
export const refusalByCode =
  (codes: ReadonlyArray<string>) =>
  (status: number, body: string): string | undefined => {
    if (status !== 400) return undefined;
    const parsed = parseErrorBody(body);
    return typeof parsed.code === "string" && codes.includes(parsed.code)
      ? (parsed.message ?? "The provider refused to make this image.")
      : undefined;
  };
