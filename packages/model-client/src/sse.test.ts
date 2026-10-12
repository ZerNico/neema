import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { sseEvents } from "./sse.ts";

const encoder = new TextEncoder();
const parse = (chunks: ReadonlyArray<Uint8Array>, limit: number) =>
  Effect.runPromise(
    sseEvents(Stream.fromIterable(chunks), () => new Error("event too large"), limit).pipe(
      Stream.runCollect,
      Effect.map((events) => Array.from(events)),
    ),
  );

// Small caps exercise the production admission path without oversized fixtures.
describe("SSE event byte admission", () => {
  for (const ending of ["\n\n", "\r\r", "\r\n\r\n", ""] as const) {
    for (const multibyte of [false, true]) {
      it.each([-1, 0, 1])(
        `checks limit%+i with ${JSON.stringify(ending)} and ${multibyte ? "UTF-8" : "ASCII"}`,
        async (offset) => {
          const limit = 24;
          const prefix = multibyte ? "€€€" : "";
          const value =
            prefix + "x".repeat(limit + offset - 6 - ending.length - encoder.encode(prefix).length);
          const bytes = encoder.encode(`data: ${value}${ending}`);
          expect(bytes.length).toBe(limit + offset);
          if (offset > 0) await expect(parse([bytes], limit)).rejects.toThrow("event too large");
          else expect(await parse([bytes], limit)).toEqual([{ event: undefined, data: value }]);
        },
      );
    }
  }

  it("checks before a crossing multi-line event dispatches and resets", async () => {
    const bytes = encoder.encode("event: a\ndata: one\ndata: two\n\n");
    const seen: string[] = [];
    await expect(
      Effect.runPromise(
        sseEvents(
          Stream.fromIterable([bytes.subarray(0, 20), bytes.subarray(20)]),
          () => new Error("event too large"),
          bytes.length - 1,
        ).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              seen.push(event.data);
            }),
          ),
        ),
      ),
    ).rejects.toThrow("event too large");
    expect(seen).toEqual([]);
    expect(await parse([bytes], bytes.length)).toEqual([{ event: "a", data: "one\ntwo" }]);
  });

  it("caps each event, not the transport chunk containing several", async () => {
    const one = "data: one\r\n\r\n";
    expect(await parse([encoder.encode(one.repeat(4))], encoder.encode(one).length)).toEqual(
      Array.from({ length: 4 }, () => ({ event: undefined, data: "one" })),
    );
  });

  it.each(["\n", "\r", "\r\n"])(
    "counts UTF-8 and %j delimiters across every chunk boundary",
    async (ending) => {
      const bytes = encoder.encode(`event: €${ending}data: ü😀${ending}${ending}`);
      for (let split = 0; split <= bytes.length; split++) {
        const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
        expect(await parse(chunks, bytes.length)).toEqual([{ event: "€", data: "ü😀" }]);
        await expect(parse(chunks, bytes.length - 1)).rejects.toThrow("event too large");
      }
    },
  );

  it.each([":", "ignored:", "event:", "data:"])(
    "counts unfinished %s fields even without dispatch",
    async (field) => {
      const bytes = encoder.encode(`${field} ${"x".repeat(24)}`);
      await expect(parse([bytes], 24)).rejects.toThrow("event too large");
      await expect(parse([bytes, encoder.encode("\n\n")], 24)).rejects.toThrow("event too large");
    },
  );

  it("counts comments and ignored fields in the same event", async () => {
    const bytes = encoder.encode(": keepalive\nignored: text\ndata: value\n\n");
    expect(await parse([bytes], bytes.length)).toEqual([{ event: undefined, data: "value" }]);
    await expect(parse([bytes], bytes.length - 1)).rejects.toThrow("event too large");
  });

  it("flushes incomplete UTF-8 at EOF under the wire-byte cap", async () => {
    const bytes = new Uint8Array([...encoder.encode("data: "), 0xe2, 0x82]);
    expect(await parse([bytes.subarray(0, 7), bytes.subarray(7)], bytes.length)).toEqual([
      { event: undefined, data: "�" },
    ]);
    await expect(parse([bytes], bytes.length - 1)).rejects.toThrow("event too large");
  });
});
