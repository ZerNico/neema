import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { catalogImagePricing, fetchCatalog } from "./catalog.ts";
import { makeConnection } from "./connection.ts";

const bedrock = (profiles: Response, images?: Response) => {
  const urls: string[] = [];
  const fetch = async (url: RequestInfo | URL) => {
    urls.push(String(url));
    if (String(url).includes("/foundation-models"))
      return images ?? Response.json({ Message: "not authorized" }, { status: 403 });
    return String(url).includes("/inference-profiles")
      ? profiles
      : Response.json({ data: [{ id: "openai.gpt-oss-120b" }] });
  };
  const connection = makeConnection({
    provider: "p1",
    preset: "bedrock",
    baseUrl: "eu-central-1",
    credentials: { kind: "key", key: "ABSK-test" },
  })!;
  const run = fetchCatalog(connection).pipe(
    Effect.map((models) => models.map((model) => model.id)),
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  return { urls, run: () => Effect.runPromise(run) };
};

describe("Bedrock catalog", () => {
  it("adds the account's active Claude inference profiles to mantle's listing", async () => {
    const catalog = bedrock(
      Response.json({
        inferenceProfileSummaries: [
          { inferenceProfileId: "eu.anthropic.claude-sonnet-4-6", status: "ACTIVE" },
          { inferenceProfileId: "global.anthropic.claude-opus-5-5", status: "ACTIVE" },
          // Not Claude: its profiles go to mantle, which takes none.
          { inferenceProfileId: "eu.meta.llama3-2-3b-instruct-v1:0", status: "ACTIVE" },
          { inferenceProfileId: "eu.anthropic.claude-3-haiku-20240307-v1:0", status: "LEGACY" },
        ],
      }),
    );
    expect(await catalog.run()).toEqual([
      "openai.gpt-oss-120b",
      "eu.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-opus-5-5",
    ]);
    expect(catalog.urls).toContain(
      "https://bedrock.eu-central-1.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000",
    );
  });

  it("still lists mantle's models when listing profiles is not allowed", async () => {
    const catalog = bedrock(Response.json({ Message: "not authorized" }, { status: 403 }));
    expect(await catalog.run()).toEqual(["openai.gpt-oss-120b"]);
  });
});

const catalogOf = (
  preset: Parameters<typeof makeConnection>[0]["preset"],
  pages: Record<string, unknown>,
  baseUrl = "https://provider.test/v1",
) => {
  const fetch = async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    // Longest suffix first, so `/images/models` is not read as `/models`.
    const page = Object.entries(pages)
      .toSorted(([a], [b]) => b.length - a.length)
      .find(([suffix]) => path.endsWith(suffix));
    return page ? Response.json(page[1]) : Response.json({ error: "nope" }, { status: 404 });
  };
  const connection = makeConnection({
    provider: "p1",
    preset,
    baseUrl,
    credentials: { kind: "key", key: "k" },
  })!;
  return Effect.runPromise(
    fetchCatalog(connection).pipe(
      Effect.map((models) =>
        models.map((model) => ({
          id: model.id,
          type: model.type,
          ...(model.imageFamily ? { imageFamily: model.imageFamily } : {}),
          ...(model.imagePricing ? { imagePricing: model.imagePricing } : {}),
        })),
      ),
      Effect.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );
};

describe("OpenRouter image prices", () => {
  it("reads a flat fee per reference only beside a price per image token", () => {
    expect(
      catalogImagePricing({
        prompt: "0",
        image: "0.01",
        image_token: "0.00000958",
        image_output: "0.00000958",
      }),
    ).toEqual({ tokens: { textInput: 0, imageInput: 9.58, output: 9.58 }, perReference: 0.01 });
    // Gemini's `image` is the per-token price of an image read, like `prompt`.
    expect(
      catalogImagePricing({
        prompt: "0.000002",
        completion: "0.000012",
        image: "0.000002",
        image_output: "0.00012",
      }),
    ).toEqual({ tokens: { textInput: 2, imageInput: 2, output: 120 } });
    expect(catalogImagePricing({ prompt: "0.000008", image_output: "0.00003" })).toEqual({
      tokens: { textInput: 8, imageInput: 8, output: 30 },
    });
    expect(catalogImagePricing({ prompt: "-1" })).toBeNull();
  });

  it("reach the image entries from the listing asked for image output", async () => {
    const models = await catalogOf("openrouter", {
      "/models": { data: [] },
      "/models?output_modalities=embeddings": { data: [] },
      "/models?output_modalities=image": {
        data: [
          {
            id: "x-ai/grok-imagine-image-2.0",
            pricing: { image: "0.01", image_token: "0.00001", image_output: "0.00001" },
          },
        ],
      },
      "/images/models": {
        data: [
          { id: "x-ai/grok-imagine-image-2.0", name: "Grok Imagine" },
          { id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro" },
        ],
      },
    });
    expect(models).toEqual([
      {
        id: "x-ai/grok-imagine-image-2.0",
        type: "image",
        imageFamily: "openrouter-image",
        imagePricing: { tokens: { textInput: 0, imageInput: 10, output: 10 }, perReference: 0.01 },
      },
      { id: "black-forest-labs/flux.2-pro", type: "image", imageFamily: "openrouter-image" },
    ]);
  });
});

describe("image models in catalogs", () => {
  it("types OpenAI's image models as image by id", async () => {
    expect(
      await catalogOf("openai", {
        "/models": { data: [{ id: "gpt-5.4" }, { id: "gpt-image-2" }, { id: "dall-e-3" }] },
      }),
    ).toEqual([
      { id: "gpt-5.4", type: "chat" },
      { id: "gpt-image-2", type: "image", imageFamily: "gpt-image" },
      { id: "dall-e-3", type: "image", imageFamily: "dall-e-3" },
    ]);
  });

  it("trusts a listing's own type where it has one", async () => {
    expect(
      await catalogOf("vercel", {
        "/models": {
          data: [
            { id: "google/gemini-3.1-flash-image", type: "language" },
            { id: "openai/gpt-image-2", type: "image" },
            { id: "bfl/flux-2-pro", type: "image" },
          ],
        },
      }),
    ).toEqual([
      { id: "google/gemini-3.1-flash-image", type: "chat" },
      { id: "openai/gpt-image-2", type: "image", imageFamily: "gpt-image" },
      { id: "bfl/flux-2-pro", type: "image", imageFamily: "openai-compatible-image" },
    ]);
  });

  it("includes Azure image deployments by their base model", async () => {
    expect(
      await catalogOf(
        "azure",
        {
          "/openai/deployments?api-version=2022-12-01": {
            data: [
              { id: "chat", model: "gpt-5.4", status: "succeeded" },
              { id: "pictures", model: "gpt-image-1.5", status: "succeeded" },
              { id: "old", model: "dall-e-3", status: "succeeded" },
              { id: "voice", model: "whisper", status: "succeeded" },
            ],
          },
        },
        "https://res.openai.azure.com",
      ),
    ).toEqual([
      { id: "chat", type: "chat" },
      { id: "pictures", type: "image", imageFamily: "gpt-image" },
      { id: "old", type: "image", imageFamily: "dall-e-3" },
    ]);
  });

  it("lists an OpenRouter model that also draws once per type, and image-only ones", async () => {
    expect(
      await catalogOf("openrouter", {
        "/models": {
          data: [
            {
              id: "google/gemini-2.5-flash-image",
              architecture: { output_modalities: ["text", "image"] },
            },
            { id: "anthropic/claude-sonnet-5", architecture: { output_modalities: ["text"] } },
            { id: "bytedance-seed/seedream-4.5", architecture: { output_modalities: ["image"] } },
          ],
        },
        "/models?output_modalities=embeddings": { data: [] },
        "/images/models": {
          data: [
            { id: "google/gemini-2.5-flash-image", name: "Nano Banana" },
            { id: "bytedance-seed/seedream-4.5", name: "Seedream 4.5" },
          ],
        },
      }),
    ).toEqual([
      { id: "google/gemini-2.5-flash-image", type: "chat" },
      { id: "google/gemini-2.5-flash-image", type: "image", imageFamily: "openrouter-image" },
      { id: "anthropic/claude-sonnet-5", type: "chat" },
      { id: "bytedance-seed/seedream-4.5", type: "image", imageFamily: "openrouter-image" },
    ]);
  });

  it("lists Bedrock's on-demand image foundation models", async () => {
    const catalog = bedrock(
      Response.json({ inferenceProfileSummaries: [] }),
      Response.json({
        modelSummaries: [
          {
            modelId: "amazon.nova-canvas-v1:0",
            modelName: "Nova Canvas",
            inferenceTypesSupported: ["ON_DEMAND"],
            modelLifecycle: { status: "ACTIVE" },
          },
          {
            modelId: "stability.sd3-5-large-v1:0",
            inferenceTypesSupported: ["ON_DEMAND"],
            modelLifecycle: { status: "ACTIVE" },
          },
          {
            modelId: "amazon.titan-image-generator-v1",
            inferenceTypesSupported: ["ON_DEMAND"],
            modelLifecycle: { status: "LEGACY" },
          },
          {
            modelId: "stability.stable-image-remove-background-v1:0",
            inferenceTypesSupported: ["ON_DEMAND"],
          },
        ],
      }),
    );
    expect(await catalog.run()).toEqual([
      "openai.gpt-oss-120b",
      "amazon.nova-canvas-v1:0",
      "stability.sd3-5-large-v1:0",
    ]);
    expect(catalog.urls).toContain(
      "https://bedrock.eu-central-1.amazonaws.com/foundation-models?byOutputModality=IMAGE",
    );
  });
});
