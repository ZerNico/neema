import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  effectiveSettings,
  getPreset,
  PRESETS,
  resolveBaseUrl,
  sanitizeSettings,
} from "./preset.ts";
import { sseEvents } from "./sse.ts";

describe("presets", () => {
  it("have unique ids and a usable default format", () => {
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(PRESETS.length);
    for (const preset of PRESETS) expect(preset.formats).toContain(preset.defaults.format);
  });

  it("keep only the overrides a preset allows, and only real changes", () => {
    expect(sanitizeSettings(getPreset("openrouter"), { format: "responses" })).toEqual({});
    expect(sanitizeSettings(getPreset("openai"), { format: "responses" })).toEqual({});
    expect(sanitizeSettings(getPreset("openai"), { format: "chat-completions" })).toEqual({
      format: "chat-completions",
    });
    expect(sanitizeSettings(getPreset("custom"), { keyHeader: "x-api-key\nbad" })).toEqual({});
    expect(effectiveSettings(getPreset("custom"), { reasoning: "flat" }).reasoning).toBe("flat");
  });

  it("completes an Azure resource URL to its v1 API", () => {
    const azure = getPreset("azure");
    expect(resolveBaseUrl(azure, "https://res.openai.azure.com/")).toBe(
      "https://res.openai.azure.com/openai/v1",
    );
    expect(resolveBaseUrl(azure, "https://res.openai.azure.com/openai/v1")).toBe(
      "https://res.openai.azure.com/openai/v1",
    );
    expect(resolveBaseUrl(azure, "")).toBeNull();
    expect(resolveBaseUrl(getPreset("openrouter"), "")).toBe("https://openrouter.ai/api/v1");
  });
});

describe("server-sent events", () => {
  const parse = (chunks: ReadonlyArray<string>) =>
    Effect.runPromise(
      sseEvents(
        Stream.fromIterable(chunks.map((chunk) => new TextEncoder().encode(chunk))),
        () => new Error("too large"),
      ).pipe(
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
      ),
    );

  it("reads any line ending, split anywhere, multi-line data and comments", async () => {
    expect(
      await parse([
        ": keepalive\r\n",
        "event: a\r",
        '\ndata: {"x":',
        "1}\r\n\r\n",
        "data: l1\ndata: l2\n\n",
      ]),
    ).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: undefined, data: "l1\nl2" },
    ]);
  });

  it("keeps a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: ü\n\n");
    const events = await Effect.runPromise(
      sseEvents(
        Stream.fromIterable([bytes.slice(0, 7), bytes.slice(7)]),
        () => new Error("too large"),
      ).pipe(
        Stream.runCollect,
        Effect.map((all) => Array.from(all)),
      ),
    );
    expect(events).toEqual([{ event: undefined, data: "ü" }]);
  });

  it("delivers a last event the server never terminated", async () => {
    expect(await parse(["data: tail"])).toEqual([{ event: undefined, data: "tail" }]);
  });
});
