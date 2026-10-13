import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MAX_BASE64_LENGTH } from "./bytes.ts";
import { generateImages } from "./generate.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import { b64, gif, imageServer, jpeg, png, reference } from "./test-server.ts";

const request = (extra: Partial<NormalizedImageRequest> = {}): NormalizedImageRequest => ({
  prompt: "A lighthouse",
  references: [],
  aspectRatio: "1:1",
  size: "1024x1024",
  quality: null,
  background: null,
  count: 1,
  ...extra,
});

describe("OpenAI Images API", () => {
  it("generates with GPT Image fields and never asks for a response format", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          body: {
            data: [{ b64_json: b64(png()) }],
            usage: {
              input_tokens: 50,
              input_tokens_details: { text_tokens: 40, image_tokens: 10 },
              output_tokens: 4000,
              total_tokens: 4050,
            },
          },
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request({
          quality: "high",
          background: "transparent",
          count: 2,
          size: "1536x1024",
        }),
      }),
    );
    expect(server.exchanges[0]!.url).toBe("https://provider.test/v1/images/generations");
    expect(server.exchanges[0]!.headers["authorization"]).toBe("Bearer sk-test");
    expect(server.exchanges[0]!.json).toEqual({
      model: "gpt-image-2",
      prompt: "A lighthouse",
      n: 2,
      size: "1536x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
    });
    expect(result).toEqual({
      kind: "images",
      images: [{ mediaType: "image/png", data: png() }],
      usage: { inputTokens: 50, textInputTokens: 40, imageInputTokens: 10, outputTokens: 4000 },
    });
  });

  it("maps DALL-E 3 quality, asks for base64 and keeps the revised prompt", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        { body: { data: [{ b64_json: b64(png()), revised_prompt: "A tall lighthouse" }] } },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "dall-e-3",
        family: "dall-e-3",
        request: request({ quality: "high" }),
      }),
    );
    expect(server.exchanges[0]!.json).toEqual({
      model: "dall-e-3",
      prompt: "A lighthouse",
      n: 1,
      size: "1024x1024",
      quality: "hd",
      response_format: "b64_json",
    });
    expect(result).toMatchObject({ kind: "images", revisedPrompt: "A tall lighthouse" });
  });

  it("edits with GPT Image as multipart, one image[] field per reference", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [{ body: { data: [{ b64_json: b64(jpeg()) }] } }],
    });
    await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request({
          references: [reference("a.png", png()), reference("b.jpg", jpeg(), "image/jpeg")],
        }),
      }),
    );
    const exchange = server.exchanges[0]!;
    expect(exchange.url).toBe("https://provider.test/v1/images/edits");
    expect(exchange.headers["authorization"]).toBe("Bearer sk-test");
    expect(exchange.form).toEqual([
      ["model", "gpt-image-2"],
      ["prompt", "A lighthouse"],
      ["n", "1"],
      ["size", "1024x1024"],
      ["image[]", { name: "a.png", type: "image/png", size: png().length }],
      ["image[]", { name: "b.jpg", type: "image/jpeg", size: jpeg().length }],
    ]);
  });

  it("edits with DALL-E 2 through a single image field", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [{ body: { data: [{ b64_json: b64(png()) }] } }],
    });
    await server.run(
      generateImages(server.connection, {
        model: "dall-e-2",
        family: "dall-e-2",
        request: request({ references: [reference("a.png", png())] }),
      }),
    );
    expect(server.exchanges[0]!.form.map(([key]) => key)).toEqual([
      "model",
      "prompt",
      "n",
      "size",
      "response_format",
      "image",
    ]);
  });

  it("reaches Azure's v1 path with its key header", async () => {
    const server = imageServer({
      preset: "azure",
      baseUrl: "https://res.openai.azure.com",
      answers: [{ body: { data: [{ b64_json: b64(png()) }] } }],
    });
    await server.run(
      generateImages(server.connection, {
        model: "my-image",
        family: "gpt-image",
        request: request(),
      }),
    );
    expect(server.exchanges[0]!.url).toBe(
      "https://res.openai.azure.com/openai/v1/images/generations",
    );
    expect(server.exchanges[0]!.headers["api-key"]).toBe("sk-test");
  });

  it("reads a moderation block as a refusal", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          status: 400,
          body: {
            error: {
              type: "image_generation_user_error",
              code: "moderation_blocked",
              message: "Your request was rejected by the safety system.",
            },
          },
        },
      ],
    });
    expect(
      await server.run(
        generateImages(server.connection, {
          model: "gpt-image-2",
          family: "gpt-image",
          request: request(),
        }),
      ),
    ).toEqual({ kind: "refused", message: "Your request was rejected by the safety system." });
  });

  it("fails on other HTTP errors with the provider's words", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        { status: 400, body: { error: { message: "Invalid size", code: "invalid_value" } } },
      ],
    });
    const error = await server.fail(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
      }),
    );
    expect(error.message).toContain("Invalid size");
  });

  it("refuses URLs, empty answers and bytes that are not what they claim", async () => {
    const run = async (body: unknown) => {
      const server = imageServer({ preset: "custom", answers: [{ body }] });
      const error = await server.fail(
        generateImages(server.connection, {
          model: "flux",
          family: "openai-compatible-image",
          request: request(),
        }),
      );
      return error.message;
    };
    expect(await run({ data: [{ url: "https://cdn.test/a.png" }] })).toContain(
      "base64 image data is required",
    );
    expect(await run({ data: [] })).toContain("returned no image");
    expect(await run({ data: [{ b64_json: b64(gif()) }] })).toContain("not a PNG, JPEG or WebP");
    expect(await run({ data: [{ b64_json: "not base64!" }] })).toContain("not base64");
    expect(await run({ data: [{ b64_json: b64(png()), mime_type: "image/webp" }] })).toContain(
      "labelled a image/png image as image/webp",
    );
    expect(await run({ data: [{ b64_json: "A".repeat(MAX_BASE64_LENGTH + 4) }] })).toContain(
      "larger than 20 MB",
    );
    // The whole answer is capped before it is parsed.
    expect(
      await run({ data: [{ b64_json: "A".repeat(MAX_BASE64_LENGTH + 2_000_000) }] }),
    ).toContain("answer is too large");
  });

  it("refuses a family the provider does not host", async () => {
    const server = imageServer({ preset: "openai", answers: [] });
    const error = await server.fail(
      generateImages(server.connection, { model: "grok", family: "xai-image", request: request() }),
    );
    expect(error.message).toContain("OpenAI does not serve xAI Grok Imagine models");
    expect(server.exchanges).toEqual([]);
  });

  it("times out as a network error and aborts the request", async () => {
    const server = imageServer({ preset: "openai", answers: ["hang"] });
    const error = await server.fail(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
        timeoutMs: 20,
      }),
    );
    expect(error.reason._tag).toBe("NetworkError");
    expect(error.message).toContain("did not answer within 1 second");
    expect(server.exchanges[0]!.signal?.aborted).toBe(true);
  });
});

describe("GPT Image partial previews", () => {
  const partial = (index: number) => ({
    type: "image_generation.partial_image",
    b64_json: b64(png()),
    partial_image_index: index,
  });

  it("streams previews to the listener, then returns the finished image with its usage", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          events: [
            partial(0),
            partial(1),
            {
              type: "image_generation.completed",
              b64_json: b64(png()),
              usage: { input_tokens: 10, output_tokens: 100 },
            },
          ],
        },
      ],
    });
    const seen: number[] = [];
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
        onPartial: (preview) =>
          Effect.sync(() => {
            seen.push(preview.index);
          }),
      }),
    );
    expect(server.exchanges[0]!.json).toMatchObject({ stream: true, partial_images: 2 });
    expect(seen).toEqual([0, 1]);
    expect(result).toMatchObject({
      kind: "images",
      images: [{ mediaType: "image/png" }],
      usage: { inputTokens: 10, outputTokens: 100 },
    });
  });

  it("streams an edit as a form, and reads a refusal sent mid-stream", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          events: [
            {
              type: "error",
              error: { code: "moderation_blocked", message: "Rejected by the safety system." },
            },
          ],
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request({ references: [reference("a.png", png())] }),
        onPartial: () => Effect.void,
      }),
    );
    expect(server.exchanges[0]!.url).toBe("https://provider.test/v1/images/edits");
    expect(server.exchanges[0]!.form).toContainEqual(["stream", "true"]);
    expect(result).toEqual({ kind: "refused", message: "Rejected by the safety system." });
  });

  it("keeps one request per batch and other families unstreamed", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [{ body: { data: [{ b64_json: b64(png()) }, { b64_json: b64(png()) }] } }],
    });
    await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request({ count: 2 }),
        onPartial: () => Effect.die("a batch never streams"),
      }),
    );
    expect(server.exchanges[0]!.json).not.toHaveProperty("stream");
  });

  it("returns at the finished image without waiting for the stream to close", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          open: true,
          events: [{ type: "image_generation.completed", b64_json: b64(png()) }],
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
        onPartial: () => Effect.void,
      }),
    );
    expect(result).toMatchObject({ kind: "images", images: [{ mediaType: "image/png" }] });
  });

  it("reads a gateway that answers a streamed request with JSON", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          body: {
            data: [{ b64_json: b64(png()) }],
            usage: { input_tokens: 3, output_tokens: 30 },
          },
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
        onPartial: () => Effect.die("no previews in a JSON answer"),
      }),
    );
    expect(server.exchanges[0]!.json).toMatchObject({ stream: true });
    expect(result).toMatchObject({
      kind: "images",
      images: [{ mediaType: "image/png" }],
      usage: { inputTokens: 3, outputTokens: 30 },
    });
  });

  it("keeps the usage of a completion that came without its image", async () => {
    const server = imageServer({
      preset: "openai",
      answers: [
        {
          events: [
            { type: "image_generation.completed", usage: { input_tokens: 12, output_tokens: 100 } },
          ],
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "gpt-image-2",
        family: "gpt-image",
        request: request(),
        onPartial: () => Effect.void,
      }),
    );
    expect(result).toMatchObject({
      kind: "unusable",
      usage: { inputTokens: 12, outputTokens: 100 },
    });
  });

  it("fails when the stream ends without a finished image", async () => {
    const server = imageServer({ preset: "openai", answers: [{ events: [partial(0)] }] });
    await expect(
      server.run(
        generateImages(server.connection, {
          model: "gpt-image-2",
          family: "gpt-image",
          request: request(),
          onPartial: () => Effect.void,
        }),
      ),
    ).rejects.toThrow(/no image/);
  });
});
