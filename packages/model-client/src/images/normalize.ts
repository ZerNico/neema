/**
 * Fits what was asked for to what a model can do. Every change is reported as
 * one sentence, so the chat model can tell the person what it drew instead.
 */

import { imageSize, sniffImage } from "./bytes.ts";
import {
  effectiveImageCapabilities,
  IMAGE_QUALITIES,
  imageFamily,
  type AspectRatio,
  type ImageCapabilities,
  type ImageFamily,
  type ImageQuality,
} from "./families.ts";

export interface ImageReference {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ImageRequestInput {
  readonly prompt: string;
  readonly references: ReadonlyArray<ImageReference>;
  /** How many references were named, when the caller read only as many as the model takes. */
  readonly referencesNamed?: number;
  readonly aspectRatio?: AspectRatio;
  readonly quality?: ImageQuality;
  readonly background?: "transparent" | "opaque";
  readonly count?: number;
}

/** The request as it will actually be sent, after fitting the model. */
export interface NormalizedImageRequest {
  readonly prompt: string;
  readonly references: ReadonlyArray<ImageReference>;
  readonly aspectRatio: AspectRatio;
  /** Exact `WxH` when the family takes sizes. */
  readonly size: string | null;
  readonly quality: ImageQuality | null;
  readonly background: "transparent" | "opaque" | null;
  readonly count: number;
}

export interface NormalizedImage {
  readonly request: NormalizedImageRequest;
  readonly adjustments: ReadonlyArray<string>;
  readonly refusal?: string;
}

const ratioOf = (ratio: AspectRatio) => {
  const [width, height] = ratio.split(":").map(Number);
  return width! / height!;
};

const nearestRatio = (target: number, available: ReadonlyArray<AspectRatio>) =>
  available.reduce((best, ratio) =>
    Math.abs(Math.log(ratioOf(ratio) / target)) < Math.abs(Math.log(ratioOf(best) / target))
      ? ratio
      : best,
  );

/** The closest quality by rank; a tie goes to the cheaper one. */
const nearestQuality = (wanted: ImageQuality, available: ReadonlyArray<ImageQuality>) => {
  const target = IMAGE_QUALITIES.indexOf(wanted);
  const distance = (quality: ImageQuality) => Math.abs(IMAGE_QUALITIES.indexOf(quality) - target);
  return available.reduce((best, quality) => (distance(quality) < distance(best) ? quality : best));
};

const TYPE_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

const listOf = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

const images = (count: number) => (count === 1 ? "one image" : `${count} images`);

/**
 * Fits a request to a model. Never fails: every change is one short sentence
 * in `adjustments`. `refusal` is set only when the request cannot run at all.
 */
export const normalizeImageRequest = (
  family: ImageFamily,
  capabilities: ImageCapabilities,
  input: ImageRequestInput,
): NormalizedImage => {
  const info = imageFamily(family);
  const caps = effectiveImageCapabilities(family, capabilities);
  const adjustments: string[] = [];
  let refusal: string | undefined;
  const refuse = (sentence: string) => {
    refusal ??= sentence;
  };

  if (input.prompt.trim() === "") refuse("The prompt is empty.");

  let references = input.references.map((reference) => ({
    ...reference,
    mediaType: sniffImage(reference.bytes) ?? reference.mediaType,
  }));
  if (references.length === 0 && !caps.generate)
    refuse("This model only edits images, so it needs at least one reference image.");
  if (references.length > 0) {
    if (!caps.edit)
      refuse("This model only creates new images from a prompt and cannot use reference images.");
    else if (Math.max(references.length, input.referencesNamed ?? 0) > caps.edit.maxReferences) {
      const max = caps.edit.maxReferences;
      references = references.slice(0, max);
      adjustments.push(
        `This model takes at most ${max === 1 ? "one reference image" : `${max} reference images`}, so only the first ${max === 1 ? "one was" : `${max} were`} used.`,
      );
    }
    const accepted = info.referenceTypes.map((type) => TYPE_NAMES[type]!);
    for (const reference of references) {
      if (!info.referenceTypes.some((type) => type === reference.mediaType))
        refuse(`${reference.name} is not a ${listOf(accepted)} image, which this model needs.`);
      else if (family === "dall-e-2") {
        const size = imageSize(reference.bytes);
        if (!size || size.width !== size.height)
          refuse(`${reference.name} is not square, and DALL-E 2 edits only square PNG images.`);
      }
    }
  }

  const fallback: AspectRatio = caps.aspectRatios.includes("1:1") ? "1:1" : caps.aspectRatios[0]!;
  const firstSize = references[0] ? imageSize(references[0].bytes) : null;
  const fromReference =
    firstSize && firstSize.height > 0
      ? nearestRatio(firstSize.width / firstSize.height, caps.aspectRatios)
      : fallback;
  // Stability's image-to-image keeps the reference's shape and takes no ratio.
  const keepsReferenceShape = family === "stability" && references.length > 0;
  let aspectRatio: AspectRatio;
  if (!input.aspectRatio) aspectRatio = references.length > 0 ? fromReference : fallback;
  else if (keepsReferenceShape) {
    aspectRatio = fromReference;
    if (aspectRatio !== input.aspectRatio)
      adjustments.push("With a reference image this model keeps the reference’s aspect ratio.");
  } else {
    aspectRatio = caps.aspectRatios.includes(input.aspectRatio)
      ? input.aspectRatio
      : nearestRatio(ratioOf(input.aspectRatio), caps.aspectRatios);
    if (aspectRatio !== input.aspectRatio)
      adjustments.push(`${input.aspectRatio} is not available, so the image is ${aspectRatio}.`);
  }

  let quality: ImageQuality | null = null;
  // Unasked, the provider picks its own quality, which may be one the admin
  // took away. Where the allowed set is narrower than the family's, the
  // cheapest allowed quality is sent instead.
  const narrowed = caps.qualities.length < info.limits.qualities.length;
  if (!input.quality && narrowed && caps.qualities.length > 0)
    quality = IMAGE_QUALITIES.find((item) => caps.qualities.includes(item)) ?? null;
  if (input.quality) {
    if (caps.qualities.length === 0)
      adjustments.push(`This model has no quality setting, so ${input.quality} was ignored.`);
    else {
      quality = nearestQuality(input.quality, caps.qualities);
      if (quality !== input.quality)
        adjustments.push(`${input.quality} quality is not available, so ${quality} is used.`);
    }
  }

  let background: "transparent" | "opaque" | null = null;
  if (input.background === "transparent" && !caps.transparency)
    adjustments.push(
      "This model cannot make transparent backgrounds, so the background is opaque.",
    );
  else if (input.background && caps.transparency) background = input.background;

  const asked = Math.floor(input.count ?? 1);
  const count = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, caps.maxCount));
  if (asked > count)
    adjustments.push(
      `This model makes at most ${images(caps.maxCount)} per request, so ${images(count)} will be made.`,
    );

  const request: NormalizedImageRequest = {
    prompt: input.prompt,
    references,
    aspectRatio,
    size: info.sizes?.[aspectRatio] ?? null,
    quality,
    background,
    count,
  };
  return refusal === undefined ? { request, adjustments } : { request, adjustments, refusal };
};
