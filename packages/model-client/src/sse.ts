import { Effect, Stream } from "effect";

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** One event this large is not a model streaming text; it is a broken or hostile peer. */
const MAX_EVENT_BYTES = 64 * 1024 * 1024;

/**
 * Server-sent events from a byte stream, per the WHATWG parsing rules. The cap
 * counts wire bytes, including ignored fields and line endings, per event, not
 * per transport chunk. UTF-8 decoding survives characters split across chunks.
 */
export const sseEvents = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  tooLarge: () => E,
  maxEventBytes = MAX_EVENT_BYTES,
): Stream.Stream<SseEvent, E> =>
  Stream.suspend(() => {
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingCR = false;
    let event: string | undefined;
    let data: string[] = [];
    let size = 0;

    const line = (out: SseEvent[]) => {
      const text = buffer;
      buffer = "";
      if (text === "") {
        if (data.length > 0) out.push({ event, data: data.join("\n") });
        event = undefined;
        data = [];
        size = 0;
        return;
      }
      if (text.startsWith(":")) return;
      const colon = text.indexOf(":");
      const field = colon === -1 ? text : text.slice(0, colon);
      let value = colon === -1 ? "" : text.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
    };

    const charge = (count: number) => {
      size += count;
      return size <= maxEventBytes;
    };
    const lines = (chunk: Uint8Array): SseEvent[] | null => {
      const out: SseEvent[] = [];
      let start = 0;
      if (pendingCR) {
        if (chunk.length === 0) return out;
        if (chunk[0] === 10) {
          if (!charge(1)) return null;
          start = 1;
        }
        line(out);
        pendingCR = false;
      }
      for (let i = start; i < chunk.length; i++) {
        const byte = chunk[i];
        if (byte !== 10 && byte !== 13) continue;
        if (!charge(i - start + 1)) return null;
        // Decode the delimiter too, flushing any preceding incomplete code point.
        buffer += decoder.decode(chunk.subarray(start, i + 1), { stream: true }).slice(0, -1);
        if (byte === 13) {
          if (i + 1 === chunk.length) {
            pendingCR = true;
            start = i + 1;
            break;
          }
          if (chunk[i + 1] === 10) {
            if (!charge(1)) return null;
            i++;
          }
        }
        line(out);
        start = i + 1;
      }
      if (!charge(chunk.length - start)) return null;
      buffer += decoder.decode(chunk.subarray(start), { stream: true });
      return out;
    };

    return bytes.pipe(
      Stream.mapEffect((chunk) => {
        const out = lines(chunk);
        return out === null ? Effect.fail(tooLarge()) : Effect.succeed(out);
      }),
      Stream.concat(
        Stream.fromEffect(
          Effect.suspend(() => {
            buffer += decoder.decode();
            if (size > maxEventBytes) return Effect.fail(tooLarge());
            const out: SseEvent[] = [];
            if (pendingCR || buffer) line(out);
            line(out);
            return Effect.succeed(out);
          }),
        ),
      ),
      Stream.flattenIterable,
    );
  });
