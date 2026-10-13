import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  baseUrlField,
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
    // OpenAI's API is fixed; Azure's is each model's, never the provider's.
    expect(sanitizeSettings(getPreset("openai"), { format: "chat-completions" })).toEqual({});
    expect(sanitizeSettings(getPreset("azure"), { format: "chat-completions" })).toEqual({});
    expect(sanitizeSettings(getPreset("custom"), { format: "responses" })).toEqual({
      format: "responses",
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

  it("turns a Bedrock region into its endpoint and keeps a typed URL", () => {
    const bedrock = getPreset("bedrock");
    expect(resolveBaseUrl(bedrock, " eu-central-1 ")).toBe(
      "https://bedrock-mantle.eu-central-1.api.aws/v1",
    );
    expect(
      resolveBaseUrl(bedrock, "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/"),
    ).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1");
    expect(resolveBaseUrl(bedrock, "")).toBeNull();
    // The admin sees what they entered: a region round-trips, a URL stays one.
    expect(baseUrlField(bedrock, resolveBaseUrl(bedrock, "eu-central-1")!)).toEqual({
      label: "Region",
      value: "eu-central-1",
    });
    const runtime = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
    expect(baseUrlField(bedrock, runtime).value).toBe(runtime);
    expect(baseUrlField(getPreset("azure")).label).toBe("Base URL");
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

  it("reads an image-sized line over many chunks, and a CR that ends a chunk alone", async () => {
    const big = "A".repeat(256 * 1024);
    const frame = `data: ${big}\n\n`;
    const chunks = Array.from({ length: Math.ceil(frame.length / 1000) }, (_, index) =>
      frame.slice(index * 1000, (index + 1) * 1000),
    );
    expect(await parse([...chunks, "data: a\r", "data: b\r\r"])).toEqual([
      { event: undefined, data: big },
      { event: undefined, data: "a\nb" },
    ]);
  });

  it("delivers a last event the server never terminated", async () => {
    expect(await parse(["data: tail"])).toEqual([{ event: undefined, data: "tail" }]);
  });
});
