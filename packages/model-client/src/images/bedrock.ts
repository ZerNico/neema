/**
 * Bedrock's InvokeModel for image models, signed like every Bedrock request.
 * Each family has its own body; all answer a list of bare base64 images.
 */

import { Effect } from "effect";
import type { Connection } from "../connection.ts";
import { invalidOutput, parseErrorBody } from "../errors.ts";
import { bedrockRuntimeOrigin } from "../preset.ts";
import { decodeImage, toBase64 } from "./bytes.ts";
import { post, str } from "./http.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import { imagesResult, noImages, refusedResult, type GeneratedImage } from "./result.ts";

type BedrockFamily = "nova-canvas" | "titan-image" | "stability";

/** How much a reference may change in Stability's image-to-image: 0 keeps it, 1 ignores it. */
const STABILITY_STRENGTH = 0.6;

const dimensions = (size: string | null) => {
  const [width, height] = (size ?? "1024x1024").split("x").map(Number);
  return { width: width!, height: height! };
};

const amazonBody = (family: "nova-canvas" | "titan-image", request: NormalizedImageRequest) => {
  const quality = request.quality ? (request.quality === "high" ? "premium" : "standard") : null;
  const variation = request.references.length > 0;
  return {
    taskType: variation ? "IMAGE_VARIATION" : "TEXT_IMAGE",
    ...(variation
      ? {
          imageVariationParams: {
            text: request.prompt,
            images: request.references.map((reference) => toBase64(reference.bytes)),
          },
        }
      : { textToImageParams: { text: request.prompt } }),
    imageGenerationConfig: {
      numberOfImages: request.count,
      ...dimensions(request.size),
      // Nova documents no quality for variations; Titan does.
      ...(quality && !(variation && family === "nova-canvas") ? { quality } : {}),
    },
  };
};

const stabilityBody = (request: NormalizedImageRequest) => {
  const reference = request.references[0];
  return {
    prompt: request.prompt,
    output_format: "png",
    ...(reference
      ? { mode: "image-to-image", image: toBase64(reference.bytes), strength: STABILITY_STRENGTH }
      : { aspect_ratio: request.aspectRatio }),
  };
};

/** Bedrock reports a content filter as a ValidationException in plain words. */
const filtered = (status: number, body: string) => {
  if (status !== 400) return undefined;
  const message = parseErrorBody(body).message;
  return message && /content filter|blocked/i.test(message) ? message : undefined;
};

export const bedrockImages = (
  connection: Connection,
  family: BedrockFamily,
  model: string,
  request: NormalizedImageRequest,
) =>
  Effect.gen(function* () {
    const reply = yield* post(connection, {
      url: `${bedrockRuntimeOrigin(connection.baseUrl)}/model/${encodeURIComponent(model)}/invoke`,
      body: family === "stability" ? stabilityBody(request) : amazonBody(family, request),
      images: request.count,
      refusal: filtered,
    });
    if (reply.kind === "refused") return refusedResult(reply.message);
    const encoded = Array.isArray(reply.value["images"])
      ? reply.value["images"].flatMap((image) => str(image) ?? [])
      : [];
    const images: GeneratedImage[] = [];
    for (const image of encoded) images.push(yield* decodeImage(image));
    if (images.length > 0) return imagesResult({ images });
    // Nova and Titan name a moderation block in `error`; Stability in `finish_reasons`.
    const error = str(reply.value["error"]);
    if (error) return refusedResult(error);
    const reasons = Array.isArray(reply.value["finish_reasons"])
      ? reply.value["finish_reasons"].flatMap((reason) => str(reason) ?? [])
      : [];
    const filter = reasons.find((reason) => reason.startsWith("Filter reason"));
    if (filter)
      return refusedResult(
        `The provider filtered the ${filter.replace(/^Filter reason:\s*/, "")}.`,
      );
    if (reasons.length > 0)
      return yield* Effect.fail(invalidOutput(`The image provider failed: ${reasons.join(", ")}`));
    return yield* Effect.fail(noImages());
  });

export const isBedrockFamily = (family: string): family is BedrockFamily =>
  family === "nova-canvas" || family === "titan-image" || family === "stability";
