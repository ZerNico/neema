import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { makeConnection } from "@chat/model-client";
import { IMAGE_TOOL } from "../tool-schema.ts";
import type { ImagePricing } from "~/modules/providers/model-config.ts";
import {
  imageCost,
  imageFileStem,
  imageModelNote,
  makeImageBudget,
  prepareImageTool,
  type ImageOperation,
} from "./image-tool.ts";

describe("imageCost", () => {
  it("takes the provider's own figure first", () => {
    expect(
      imageCost(
        { perImage: { default: 1 } },
        { quality: "high", qualities: ["high"] },
        { cost: 0.07, images: 2 },
      ),
    ).toEqual({ cost: 0.07, costSource: "provider" });
  });

  it("prices reported tokens, image input as part of input", () => {
    expect(
      imageCost(
        { tokens: { textInput: 5, imageInput: 10, output: 40 } },
        { quality: "high", qualities: ["high"] },
        {
          images: 1,
          usage: { inputTokens: 300, imageInputTokens: 100, outputTokens: 1000 },
        },
      ),
    ).toEqual({ cost: (200 * 5 + 100 * 10 + 1000 * 40) / 1_000_000, costSource: "pricing" });
  });

  it("uses the quality's price, and the default one only as an estimate", () => {
    const pricing = { perImage: { default: 0.04, high: 0.17 } };
    expect(
      imageCost(pricing, { quality: "high", qualities: ["low", "high"] }, { images: 2 }),
    ).toEqual({
      cost: 0.34,
      costSource: "pricing",
    });
    expect(
      imageCost(pricing, { quality: "low", qualities: ["low", "high"] }, { images: 2 }),
    ).toEqual({
      cost: 0.08,
      costSource: "estimate",
    });
    // A model without a quality knob has one price, which is exact.
    expect(imageCost(pricing, { quality: null, qualities: [] }, { images: 1 })).toEqual({
      cost: 0.04,
      costSource: "pricing",
    });
    // One that has them but was not told one: the provider picked, so it is a guess.
    expect(
      imageCost(pricing, { quality: null, qualities: ["low", "high"] }, { images: 1 }),
    ).toEqual({
      cost: 0.04,
      costSource: "estimate",
    });
  });

  it("leaves the cost unknown without prices or images", () => {
    expect(imageCost(null, { quality: null, qualities: [] }, { images: 1 })).toEqual({
      cost: null,
      costSource: null,
    });
    expect(
      imageCost({ perImage: { default: 1 } }, { quality: null, qualities: [] }, { images: 0 }),
    ).toEqual({
      cost: null,
      costSource: null,
    });
  });
});

describe("makeImageBudget", () => {
  it("grants what fits, counting what the answer already holds", () => {
    const budget = makeImageBudget(14, 16);
    expect(budget.reserve(4)).toBe(2);
    expect(budget.reserve(1)).toBe(0);
    budget.release(1);
    expect(budget.reserve(3)).toBe(1);
  });

  it("keeps parallel calls from spending the same slots", () => {
    const budget = makeImageBudget(0, 4);
    const first = budget.reserve(3);
    const second = budget.reserve(3);
    expect(first + second).toBe(4);
  });
});

describe("imageModelNote", () => {
  const connection = makeConnection({
    provider: "p",
    preset: "openai",
    baseUrl: null,
    credentials: null,
  })!;
  const model = {
    id: "m",
    name: "GPT Image",
    description: "Good at text in images",
    modelKey: "gpt-image-1",
    family: "gpt-image" as const,
    capabilities: {
      generate: true,
      edit: { maxReferences: 4 },
      aspectRatios: ["1:1", "3:2"] as const,
      qualities: ["low", "high"] as const,
      transparency: false,
      maxCount: 2,
    },
    pricing: null,
    connection,
  };

  it("names the model and what it can and cannot do", () => {
    const note = imageModelNote(model, false);
    expect(note).toContain('"GPT Image" (Good at text in images)');
    expect(note).toContain("up to 4 reference images");
    expect(note).toContain("aspect ratios 1:1, 3:2");
    expect(note).toContain("no transparent backgrounds");
    expect(note).not.toContain("output images yourself");
  });

  it("tells a model that draws natively when to use the tool", () => {
    expect(imageModelNote(model, true)).toContain("output images yourself");
  });
});

describe("prepareImageTool", () => {
  const connection = makeConnection({
    provider: "p",
    preset: "openai",
    baseUrl: null,
    credentials: null,
  })!;
  const handle = (maxReferences: number | null, references: ReadonlyArray<string>) => {
    const read: string[] = [];
    const tool = prepareImageTool({
      model: {
        id: "m",
        name: "GPT Image",
        description: null,
        modelKey: "gpt-image-1",
        family: "gpt-image",
        capabilities: {
          generate: true,
          edit: maxReferences === null ? null : { maxReferences },
          aspectRatios: ["1:1"],
          qualities: [],
          transparency: false,
          maxCount: 1,
        },
        pricing: null,
        connection,
      },
      resolveFile: (reference) =>
        Effect.sync(() => {
          read.push(reference);
          return {
            name: reference,
            mediaType: "image/png",
            bytes: new Uint8Array(4),
            source: { kind: "chat" as const, attachmentId: reference },
            ref: { kind: "attachment" as const, id: reference },
          };
        }),
      // Full, so the call stops before any request.
      budget: makeImageBudget(1, 1),
      record: () => Effect.void,
      rowIdFor: () => Effect.succeed("row"),
    });
    const handler = tool.group.handlers[IMAGE_TOOL] as (
      args: Record<string, unknown>,
      context: { toolCallId: string },
    ) => Effect.Effect<Record<string, unknown>>;
    return Effect.runPromise(
      handler({ prompt: "A fox", references }, { toolCallId: "c" }).pipe(
        Effect.map((result) => ({ result, read })),
      ),
    );
  };

  it("reads only as many references as the model takes", async () => {
    const { read } = await handle(1, ["a", "b", "c"]);
    expect(read).toEqual(["a"]);
  });

  it("reads one reference of a model that cannot edit, to refuse the call", async () => {
    const { result, read } = await handle(null, ["a", "b"]);
    expect(read).toEqual(["a"]);
    expect(result["error"]).toContain("cannot use reference images");
  });
});

describe("what an operation records", () => {
  // The first bytes of a 64x64 PNG: enough for sniffing and dimensions.
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
    64, 0, 0, 0, 64, 8, 6, 0, 0, 0,
  ]);
  // One stub for the block: the HTTP client keeps the first fetch it is given.
  // Each request takes the next answer; the last one repeats.
  let replies: Array<{ status?: number; body: Record<string, unknown> }> = [];
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const next = replies.length > 1 ? replies.shift()! : replies[0]!;
        return Response.json(next.body, { status: next.status ?? 200 });
      }),
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  const run = async (
    answer: Record<string, unknown>,
    pricing: ImagePricing | null,
    args: Record<string, unknown> = {},
    batch?: ReadonlyArray<{ status?: number; body: Record<string, unknown> }>,
  ) => {
    replies = batch ? [...batch] : [{ body: answer }];
    const recorded: ImageOperation[] = [];
    const tool = prepareImageTool({
      model: {
        id: "m",
        name: batch ? "Flux" : "DALL-E 3",
        description: null,
        modelKey: batch ? "black-forest-labs/flux.2-pro" : "dall-e-3",
        family: batch ? "openrouter-image" : "dall-e-3",
        capabilities: {
          generate: true,
          edit: null,
          aspectRatios: ["1:1"],
          qualities: batch ? [] : ["medium", "high"],
          transparency: false,
          maxCount: batch ? 2 : 1,
        },
        pricing,
        connection: makeConnection({
          provider: "p",
          preset: batch ? "openrouter" : "openai",
          baseUrl: "https://provider.test/v1",
          credentials: { kind: "key", key: "k" },
        })!,
      },
      resolveFile: undefined,
      budget: makeImageBudget(0, 16),
      record: (operation) => Effect.sync(() => void recorded.push(operation)),
      rowIdFor: () => Effect.succeed("row"),
    });
    const handler = tool.group.handlers[IMAGE_TOOL] as (
      args: Record<string, unknown>,
      context: { toolCallId: string },
    ) => Effect.Effect<Record<string, unknown>>;
    const result = await Effect.runPromise(
      handler({ prompt: "A fox", ...args }, { toolCallId: "c" }),
    );
    return { result, recorded, staged: tool.take("c") };
  };

  it("counts an exact price per image as the whole cost, with no usage reported", async () => {
    const { recorded } = await run(
      { data: [{ b64_json: Buffer.from(png).toString("base64") }] },
      { perImage: { medium: 0.04 } },
      { quality: "medium" },
    );
    expect(recorded).toEqual([
      expect.objectContaining({
        status: "complete",
        images: 1,
        cost: 0.04,
        costSource: "pricing",
        usage: { inputTokens: 0, outputTokens: 0, complete: true },
      }),
    ]);
  });

  it("names the staged images from the model's name, else from the prompt", async () => {
    const body = { data: [{ b64_json: Buffer.from(png).toString("base64") }] };
    expect((await run(body, null, { name: "Fox at dusk.png" })).staged?.stem).toBe("fox-at-dusk");
    expect((await run(body, null)).staged?.stem).toBe("fox");
  });

  it("reports the quality it sent, and none when the provider picked one", async () => {
    const body = { data: [{ b64_json: Buffer.from(png).toString("base64") }] };
    const sent = await run(body, null, { quality: "medium" });
    expect(sent.result).toMatchObject({ ok: true, quality: "medium" });
    const picked = await run(body, null);
    expect(picked.result["ok"]).toBe(true);
    expect(picked.result).not.toHaveProperty("quality");
  });

  it("keeps the usage of an answer whose image cannot be used", async () => {
    const { result, recorded } = await run(
      {
        data: [{ b64_json: Buffer.from([1, 2, 3, 4]).toString("base64") }],
        usage: { input_tokens: 12, output_tokens: 400 },
      },
      null,
    );
    expect(result["ok"]).toBe(false);
    expect(recorded).toEqual([
      expect.objectContaining({
        status: "error",
        images: 0,
        usage: { inputTokens: 12, outputTokens: 400, complete: true },
      }),
    ]);
  });

  it("says why a batch came back short, first among its adjustments", async () => {
    const { result } = await run({}, null, { count: 2 }, [
      { body: { data: [{ b64_json: Buffer.from(png).toString("base64") }] } },
      { status: 500, body: { error: { message: "Overloaded." } } },
    ]);
    expect(result).toMatchObject({ ok: true, images: 1 });
    expect((result["adjustments"] as string[])[0]).toMatch(/^1 of 2 images were not made: /);
  });
});

describe("imageFileStem", () => {
  it("cuts a name from the prompt's first describing words", () => {
    expect(
      imageFileStem(
        undefined,
        "A single wedge of aged cheddar cheese on a clean white marble surface",
      ),
    ).toBe("single-wedge-aged-cheddar");
  });

  it("keeps the model's own name, letters of any script included", () => {
    expect(imageFileStem("Käse-Platte (rustikal)", "ignored")).toBe("käse-platte-rustikal");
  });

  it("falls back to image when nothing describes the picture", () => {
    expect(imageFileStem("", "!!!")).toBe("image");
    expect(imageFileStem(42, "A picture of the")).toBe("image");
  });

  it("stays short", () => {
    expect(imageFileStem("x".repeat(80) + " y", "")).toHaveLength(60);
  });

  it("never cuts a character outside the basic plane in half", () => {
    const stem = imageFileStem("x".repeat(59) + "𠀀𠀀", "");
    expect(stem).toBe("x".repeat(59) + "𠀀");
    expect(stem.isWellFormed()).toBe(true);
  });
});
