import { Duration, Effect } from "effect";
import type { AiError } from "effect/ai";
import type { HttpClient } from "effect/http";
import type { Connection } from "../connection.ts";
import { configurationError, networkError } from "../errors.ts";
import { bedrockImages, isBedrockFamily } from "./bedrock.ts";
import { imageFamily, type ImageFamily } from "./families.ts";
import { geminiImages } from "./gemini-native.ts";
import type { NormalizedImageRequest } from "./normalize.ts";
import { isOpenAiFamily, openAiImages, type OnPartial } from "./openai-images.ts";
import { openRouterImages } from "./openrouter-images.ts";
import type { ImageResult } from "./result.ts";
import { xaiImages } from "./xai-images.ts";

export const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;

export interface GenerateImagesInput {
  readonly model: string;
  readonly family: ImageFamily;
  readonly request: NormalizedImageRequest;
  readonly timeoutMs?: number;
  /** Shown while the image draws, where the family streams previews (GPT Image). */
  readonly onPartial?: OnPartial;
}

type Deadline = <A>(
  effect: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>,
) => Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>;

/** Families that make one request per image, and so bound each request on its own. */
const batched = (family: ImageFamily) => family === "openrouter-image" || family === "gemini-image";

const dispatch = (connection: Connection, input: GenerateImagesInput, deadline: Deadline) => {
  const { family, model, request } = input;
  if (isOpenAiFamily(family))
    return openAiImages(connection, family, model, request, input.onPartial);
  if (isBedrockFamily(family)) return bedrockImages(connection, family, model, request);
  switch (family) {
    case "xai-image":
      return xaiImages(connection, model, request);
    case "openrouter-image":
      return openRouterImages(connection, model, request, deadline);
    case "gemini-image":
      return geminiImages(connection, model, request, deadline);
    case "imagen":
      return Effect.fail(configurationError("Imagen is no longer served by the Gemini API."));
  }
};

/**
 * One image operation, never retried. Interruption aborts the HTTP request;
 * the timeout fails like a lost connection, since the provider may still bill.
 */
export const generateImages = (
  connection: Connection,
  input: GenerateImagesInput,
): Effect.Effect<ImageResult, AiError.AiError, HttpClient.HttpClient> => {
  const presets = imageFamily(input.family).presets;
  if (!presets.some((preset) => preset === connection.preset.id))
    return Effect.fail(
      configurationError(
        `${connection.preset.label} does not serve ${imageFamily(input.family).label} models.`,
      ),
    );
  const timeoutMs = input.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const deadline: Deadline = (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            networkError(
              `The image provider did not answer within ${seconds === 1 ? "1 second" : `${seconds} seconds`}`,
            ),
          ),
      }),
    );
  return batched(input.family)
    ? dispatch(connection, input, deadline)
    : deadline(dispatch(connection, input, deadline));
};
