import { Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { makeConnection, type Credentials } from "../connection.ts";
import type { PresetId } from "../preset.ts";
import type { ImageReference } from "./normalize.ts";

export interface ImageExchange {
  readonly url: string;
  readonly headers: Record<string, string>;
  /** The JSON body, when the request had one. */
  readonly json: Record<string, unknown> | undefined;
  /** Multipart fields in order; files as `{ name, type, size }`. */
  readonly form: ReadonlyArray<
    readonly [string, string | { name: string; type: string; size: number }]
  >;
  readonly signal: AbortSignal | undefined;
}

type Answer =
  | { readonly status?: number; readonly body: unknown }
  /** A server-sent event stream, one `data:` frame per event; `open` never ends it. */
  | { readonly events: ReadonlyArray<unknown>; readonly open?: boolean }
  /** A body that never ends; `pulled` counts the chunks read from it. */
  | { readonly status: number; readonly endless: { pulled: number } }
  | "hang";

/** A synthetic image API: each request gets the next scripted answer and is recorded. */
export const imageServer = (input: {
  readonly preset: PresetId;
  readonly baseUrl?: string;
  readonly credentials?: Credentials | null;
  readonly answers: ReadonlyArray<Answer>;
}) => {
  const exchanges: ImageExchange[] = [];
  const answers = [...input.answers];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const form: Array<readonly [string, string | { name: string; type: string; size: number }]> =
      [];
    if (body instanceof FormData)
      for (const [key, value] of body.entries())
        form.push([
          key,
          typeof value === "string"
            ? value
            : { name: value.name, type: value.type, size: value.size },
        ]);
    const text =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : undefined;
    exchanges.push({
      url: String(url instanceof Request ? url.url : url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      json: text === undefined ? undefined : JSON.parse(text),
      form,
      signal: init?.signal ?? undefined,
    });
    const next = answers.shift() ?? { status: 500, body: { error: { message: "no answer" } } };
    if (next === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if ("endless" in next) {
      const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
      const counter = next.endless;
      return new Response(
        new ReadableStream({
          pull: (controller) => {
            counter.pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: next.status },
      );
    }
    if ("events" in next) {
      const frames = next.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(
        next.open
          ? new ReadableStream({
              start: (controller) => controller.enqueue(new TextEncoder().encode(frames)),
            })
          : frames,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json(next.body, { status: next.status ?? 200 });
  };
  const connection = makeConnection({
    provider: "p1",
    preset: input.preset,
    baseUrl: input.baseUrl ?? "https://provider.test/v1",
    credentials:
      input.credentials === undefined ? { kind: "key", key: "sk-test" } : input.credentials,
  })!;
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  const fail = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));
  return { exchanges, connection, run, fail };
};

const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** The first bytes of a PNG of this size: enough for sniffing and dimensions. */
export const png = (width = 64, height = 64) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ]);

/** A JPEG start with one baseline frame header. */
export const jpeg = (width = 64, height = 48) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    17,
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);

export const gif = () => new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const reference = (
  name: string,
  bytes: Uint8Array,
  mediaType = "image/png",
): ImageReference => ({
  name,
  mediaType,
  bytes,
});
