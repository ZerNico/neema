import { Effect, Stream } from "effect";

export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** One event this large is not a model streaming text; it is a broken or hostile peer. */
const MAX_EVENT_BYTES = 64 * 1024 * 1024;

/**
 * Server-sent events from a byte stream, per the WHATWG parsing rules: CR, LF
 * or CRLF line ends, multi-line `data`, comments skipped. Bytes are decoded as
 * one UTF-8 stream so a character split across chunks survives.
 */
export const sseEvents = <E>(
  bytes: Stream.Stream<Uint8Array, E>,
  tooLarge: () => E,
): Stream.Stream<SseEvent, E> =>
  Stream.suspend(() => {
    const decoder = new TextDecoder();
    let buffer = "";
    let event: string | undefined;
    let data: string[] = [];
    let size = 0;

    const lines = (text: string, final: boolean): SseEvent[] => {
      buffer += text;
      const out: SseEvent[] = [];
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i];
        if (char !== "\n" && char !== "\r") continue;
        // A CR at the very end may be the first half of CRLF still in flight.
        if (char === "\r" && i === buffer.length - 1 && !final) break;
        line(buffer.slice(start, i), out);
        if (char === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (final) {
        if (buffer) line(buffer, out);
        buffer = "";
        line("", out);
      }
      return out;
    };

    const line = (text: string, out: SseEvent[]) => {
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
      if (field === "data") {
        size += value.length;
        data.push(value);
      } else if (field === "event") event = value;
    };

    return bytes.pipe(
      Stream.mapEffect((chunk) => {
        const out = lines(decoder.decode(chunk, { stream: true }), false);
        return size + buffer.length > MAX_EVENT_BYTES
          ? Effect.fail(tooLarge())
          : Effect.succeed(out);
      }),
      Stream.concat(Stream.sync(() => lines(decoder.decode(), true))),
      Stream.flattenIterable,
    );
  });
