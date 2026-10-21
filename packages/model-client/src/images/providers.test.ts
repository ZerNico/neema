import { describe, expect, it } from "vitest";
import { generateImages } from "./generate.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import { b64, imageServer, jpeg, png, reference } from "./test-server.ts";

const request = (extra: Partial<NormalizedImageRequest> = {}): NormalizedImageRequest => ({
  prompt: "A lighthouse",
  references: [],
  aspectRatio: "16:9",
  size: null,
  quality: null,
  background: null,
  count: 1,
  ...extra,
});

describe("xAI Imagine API", () => {
  it("generates with aspect_ratio and asks for base64", async () => {
    const server = imageServer({
      preset: "xai",
      baseUrl: "https://api.x.ai/v1",
      answers: [{ body: { data: [{ b64_json: b64(jpeg()), mime_type: "image/jpeg" }] } }],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "grok-imagine-image-2.0",
        family: "xai-image",
        request: request({ quality: "low", count: 2 }),
      }),
    );
    expect(server.exchanges[0]!.url).toBe("https://api.x.ai/v1/images/generations");
    expect(server.exchanges[0]!.json).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "A lighthouse",
      n: 2,
      aspect_ratio: "16:9",
      quality: "low",
      response_format: "b64_json",
    });
    expect(result).toEqual({ kind: "images", images: [{ mediaType: "image/jpeg", data: jpeg() }] });
  });

  it("edits with one image or a list of images as data URIs", async () => {
    const server = imageServer({
      preset: "xai",
      answers: [
        { body: { data: [{ b64_json: b64(png()) }] } },
        { body: { data: [{ b64_json: b64(png()) }] } },
      ],
    });
    const one = request({ references: [reference("a.png", png())] });
    await server.run(
      generateImages(server.connection, { model: "m", family: "xai-image", request: one }),
    );
    const two = request({ references: [reference("a.png", png()), reference("b.png", png())] });
    await server.run(
      generateImages(server.connection, { model: "m", family: "xai-image", request: two }),
    );
    expect(server.exchanges[0]!.url).toBe("https://provider.test/v1/images/edits");
    expect(server.exchanges[0]!.json!["image"]).toEqual({
      type: "image_url",
      url: `data:image/png;base64,${b64(png())}`,
    });
    expect(server.exchanges[1]!.json!["images"]).toHaveLength(2);
    expect(server.exchanges[1]!.json).not.toHaveProperty("image");
  });

  it("refuses an answer with URLs only", async () => {
    const server = imageServer({
      preset: "xai",
      answers: [{ body: { data: [{ url: "https://imgen.x.ai/a.jpg" }] } }],
    });
    const error = await server.fail(
      generateImages(server.connection, { model: "m", family: "xai-image", request: request() }),
    );
    expect(error.message).toContain("base64 image data is required");
  });
});

describe("OpenRouter Images API", () => {
  it("makes one call per image and sums their cost", async () => {
    const answer = {
      body: {
        data: [{ b64_json: b64(png()), media_type: "image/png" }],
        usage: { prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010, cost: 0.04 },
      },
    };
    const server = imageServer({
      preset: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      answers: [answer, answer],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "google/gemini-2.5-flash-image",
        family: "openrouter-image",
        request: request({
          count: 2,
          quality: "high",
          background: "transparent",
          references: [reference("a.jpg", jpeg(), "image/jpeg")],
        }),
      }),
    );
    expect(server.exchanges.map((exchange) => exchange.url)).toEqual([
      "https://openrouter.ai/api/v1/images",
      "https://openrouter.ai/api/v1/images",
    ]);
    expect(server.exchanges[0]!.json).toEqual({
      model: "google/gemini-2.5-flash-image",
      prompt: "A lighthouse",
      aspect_ratio: "16:9",
      quality: "high",
      background: "transparent",
      output_format: "png",
      input_references: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64(jpeg())}` } },
      ],
    });
    expect(result).toEqual({
      kind: "images",
      images: [
        { mediaType: "image/png", data: png() },
        { mediaType: "image/png", data: png() },
      ],
      usage: { inputTokens: 20, outputTokens: 2000 },
      cost: 0.08,
      // Each call sent the reference, which a fee per reference charges twice.
      requests: 2,
    });
  });

  it("keeps the images a batch drew when one of its calls fails", async () => {
    const server = imageServer({
      preset: "openrouter",
      answers: [
        {
          body: {
            data: [{ b64_json: b64(png()), media_type: "image/png" }],
            usage: {
              input_tokens: 10,
              output_tokens: 1000,
              input_tokens_details: { text_tokens: 4, image_tokens: 6 },
              cost: 0.04,
            },
          },
        },
        { status: 500, body: { error: { message: "overloaded" } } },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "m",
        family: "openrouter-image",
        request: request({ count: 2 }),
      }),
    );
    expect(result).toEqual({
      kind: "images",
      images: [{ mediaType: "image/png", data: png() }],
      usage: { inputTokens: 10, outputTokens: 1000, textInputTokens: 4, imageInputTokens: 6 },
      cost: 0.04,
      // The failed call may have been billed too, so the totals are not the whole cost.
      incomplete: true,
      requests: 1,
      shortfall: expect.stringMatching(/^1 of 2 images were not made: /),
    });
  });

  it("keeps a finished image when another call of the batch times out", async () => {
    const answer = {
      body: {
        data: [{ b64_json: b64(png()), media_type: "image/png" }],
        usage: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.04 },
      },
    };
    const server = imageServer({ preset: "openrouter", answers: [answer, "hang"] });
    const result = await server.run(
      generateImages(server.connection, {
        model: "m",
        family: "openrouter-image",
        request: request({ count: 2 }),
        timeoutMs: 200,
      }),
    );
    expect(result).toMatchObject({
      kind: "images",
      images: [{ mediaType: "image/png" }],
      cost: 0.04,
      incomplete: true,
    });
    expect(server.exchanges[1]!.signal?.aborted).toBe(true);
  });

  it("keeps the usage of an answer whose image cannot be used", async () => {
    const server = imageServer({
      preset: "openrouter",
      answers: [
        {
          body: {
            data: [{ b64_json: b64(new Uint8Array([1, 2, 3, 4])), media_type: "image/png" }],
            usage: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.04 },
          },
        },
      ],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "m",
        family: "openrouter-image",
        request: request(),
      }),
    );
    expect(result).toMatchObject({
      kind: "unusable",
      usage: { inputTokens: 10, outputTokens: 1000 },
      cost: 0.04,
    });
  });

  it("reads an error body only up to its cap", async () => {
    const endless = { pulled: 0 };
    const server = imageServer({ preset: "openrouter", answers: [{ status: 502, endless }] });
    const error = await server.fail(
      generateImages(server.connection, {
        model: "m",
        family: "openrouter-image",
        request: request(),
      }),
    );
    expect(error.message).toBeTruthy();
    expect(endless.pulled).toBeLessThan(16);
  });

  it("fails on an empty answer", async () => {
    const server = imageServer({ preset: "openrouter", answers: [{ body: { data: [] } }] });
    const error = await server.fail(
      generateImages(server.connection, {
        model: "m",
        family: "openrouter-image",
        request: request(),
      }),
    );
    expect(error.message).toContain("returned no image");
  });
});

describe("Gemini native API", () => {
  const gemini = (answers: Parameters<typeof imageServer>[0]["answers"]) =>
    imageServer({
      preset: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      answers,
    });

  it("keeps a drawn image's billing beside a refusal that reported none, and says why it is short", async () => {
    const server = gemini([
      {
        body: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: b64(png()) } }] } },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
        },
      },
      { body: { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "Blocked." } } },
    ]);
    const result = await server.run(
      generateImages(server.connection, {
        model: "gemini-3.1-flash-image",
        family: "gemini-image",
        request: request({ count: 2 }),
      }),
    );
    expect(result).toMatchObject({
      kind: "images",
      usage: { inputTokens: 10, outputTokens: 1290 },
      incomplete: true,
      shortfall: "1 of 2 images were not made: Blocked.",
    });
  });

  it("calls generateContent with the key header and parses inline images", async () => {
    const server = gemini([
      {
        body: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "draft", thought: true },
                  { inlineData: { mimeType: "image/png", data: b64(jpeg()) }, thought: true },
                  { text: "Here is your lighthouse." },
                  { inlineData: { mimeType: "image/png", data: b64(png()) } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 300,
            candidatesTokenCount: 1290,
            thoughtsTokenCount: 10,
            promptTokensDetails: [
              { modality: "TEXT", tokenCount: 42 },
              { modality: "IMAGE", tokenCount: 258 },
            ],
          },
        },
      },
    ]);
    const result = await server.run(
      generateImages(server.connection, {
        model: "models/gemini-3.1-flash-image",
        family: "gemini-image",
        request: request({ references: [reference("a.png", png())] }),
      }),
    );
    const exchange = server.exchanges[0]!;
    expect(exchange.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    expect(exchange.headers["x-goog-api-key"]).toBe("sk-test");
    expect(exchange.headers).not.toHaveProperty("authorization");
    expect(exchange.json).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { text: "A lighthouse" },
            { inlineData: { mimeType: "image/png", data: b64(png()) } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "16:9" },
      },
    });
    expect(result).toEqual({
      kind: "images",
      images: [{ mediaType: "image/png", data: png() }],
      revisedPrompt: "Here is your lighthouse.",
      usage: { inputTokens: 300, textInputTokens: 42, imageInputTokens: 258, outputTokens: 1300 },
    });
  });

  it("reads a blocked prompt, a safety stop and a text-only answer as refusals", async () => {
    const run = async (body: unknown) => {
      const server = gemini([{ body }]);
      return server.run(
        generateImages(server.connection, {
          model: "m",
          family: "gemini-image",
          request: request(),
        }),
      );
    };
    expect(await run({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })).toEqual({
      kind: "refused",
      message: "The provider blocked the prompt (PROHIBITED_CONTENT).",
    });
    expect(
      await run({ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] }),
    ).toEqual({ kind: "refused", message: "The provider made no image (IMAGE_SAFETY)." });
    expect(
      await run({ candidates: [{ content: { parts: [{ text: "I can't draw that." }] } }] }),
    ).toEqual({ kind: "refused", message: "I can't draw that." });
  });

  it("fails when nothing came back", async () => {
    const server = gemini([
      { body: { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } },
    ]);
    const error = await server.fail(
      generateImages(server.connection, { model: "m", family: "gemini-image", request: request() }),
    );
    expect(error.message).toContain("returned no image");
  });
});

describe("Bedrock InvokeModel", () => {
  const aws = { kind: "aws", accessKeyId: "AKID", secretAccessKey: "secret" } as const;

  it("signs a Nova Canvas text-to-image call to the runtime host", async () => {
    const server = imageServer({
      preset: "bedrock",
      baseUrl: "eu-central-1",
      credentials: aws,
      answers: [{ body: { images: [b64(png()), b64(png())] } }],
    });
    const result = await server.run(
      generateImages(server.connection, {
        model: "amazon.nova-canvas-v1:0",
        family: "nova-canvas",
        request: request({ size: "1280x720", quality: "high", count: 2 }),
      }),
    );
    const exchange = server.exchanges[0]!;
    expect(exchange.url).toBe(
      "https://bedrock-runtime.eu-central-1.amazonaws.com/model/amazon.nova-canvas-v1%3A0/invoke",
    );
    expect(exchange.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-central-1\/bedrock\/aws4_request/,
    );
    expect(exchange.json).toEqual({
      taskType: "TEXT_IMAGE",
      textToImageParams: { text: "A lighthouse" },
      imageGenerationConfig: { numberOfImages: 2, width: 1280, height: 720, quality: "premium" },
    });
    expect(result).toMatchObject({ kind: "images", images: [{}, {}] });
  });

  it("sends references as an image variation", async () => {
    const server = imageServer({
      preset: "bedrock",
      baseUrl: "us-east-1",
      answers: [{ body: { images: [b64(png())] } }],
    });
    await server.run(
      generateImages(server.connection, {
        model: "amazon.titan-image-generator-v2:0",
        family: "titan-image",
        request: request({
          size: "1024x1024",
          quality: "medium",
          references: [reference("a.png", png())],
        }),
      }),
    );
    expect(server.exchanges[0]!.headers["authorization"]).toBe("Bearer sk-test");
    expect(server.exchanges[0]!.json).toEqual({
      taskType: "IMAGE_VARIATION",
      imageVariationParams: { text: "A lighthouse", images: [b64(png())] },
      imageGenerationConfig: { numberOfImages: 1, width: 1024, height: 1024, quality: "standard" },
    });
  });

  it("reads Nova's moderation error and content-filter rejections as refusals", async () => {
    const server = imageServer({
      preset: "bedrock",
      baseUrl: "us-east-1",
      answers: [
        { body: { images: [], error: "The generated image was blocked by content moderation." } },
        {
          status: 400,
          body: { message: "This request has been blocked by our content filters." },
        },
      ],
    });
    const call = generateImages(server.connection, {
      model: "amazon.nova-canvas-v1:0",
      family: "nova-canvas",
      request: request({ size: "1024x1024" }),
    });
    expect(await server.run(call)).toEqual({
      kind: "refused",
      message: "The generated image was blocked by content moderation.",
    });
    expect(await server.run(call)).toEqual({
      kind: "refused",
      message: "This request has been blocked by our content filters.",
    });
  });

  it("sends Stability's own body, image-to-image without a ratio", async () => {
    const server = imageServer({
      preset: "bedrock",
      baseUrl: "us-west-2",
      answers: [
        { body: { seeds: [1], finish_reasons: [null], images: [b64(png())] } },
        { body: { seeds: [1], finish_reasons: [null], images: [b64(png())] } },
        { body: { finish_reasons: ["Filter reason: prompt"] } },
        { body: { finish_reasons: ["Inference error"] } },
      ],
    });
    const call = (extra: Partial<NormalizedImageRequest>) =>
      generateImages(server.connection, {
        model: "stability.sd3-5-large-v1:0",
        family: "stability",
        request: request(extra),
      });
    await server.run(call({}));
    await server.run(call({ references: [reference("a.png", png())] }));
    expect(server.exchanges[0]!.json).toEqual({
      prompt: "A lighthouse",
      output_format: "png",
      aspect_ratio: "16:9",
    });
    expect(server.exchanges[1]!.json).toEqual({
      prompt: "A lighthouse",
      output_format: "png",
      mode: "image-to-image",
      image: b64(png()),
      strength: 0.6,
    });
    expect(await server.run(call({}))).toEqual({
      kind: "refused",
      message: "The provider filtered the prompt.",
    });
    expect((await server.fail(call({}))).message).toContain("Inference error");
  });
});
