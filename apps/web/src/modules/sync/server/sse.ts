import { Duration, Effect, Schedule, Stream } from "effect";
import { runtime } from "~/server/runtime.ts";

const encoder = new TextEncoder();

export const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
} as const;

export function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const heartbeat: Stream.Stream<Uint8Array> = Stream.fromEffectSchedule(
  Effect.succeed(encoder.encode(": ping\n\n")),
  Schedule.spaced(Duration.seconds(15)),
);

/**
 * Adapts an app-runtime event stream to an SSE Response. `merge` with
 * haltStrategy "left" ends the response when the data stream completes;
 * client disconnects cancel the ReadableStream which interrupts the fiber.
 */
export function sseResponse<A>(
  stream: Stream.Stream<A>,
  toFrame: (value: A) => Uint8Array,
): Promise<Response> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const context = yield* runtime.contextEffect;
      const framed = stream.pipe(
        Stream.map(toFrame),
        Stream.merge(heartbeat, { haltStrategy: "left" }),
      );
      return new Response(Stream.toReadableStreamWith(framed, context), {
        headers: sseHeaders,
      });
    }),
  );
}
