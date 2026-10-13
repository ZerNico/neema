/**
 * Image model families: the closed set of request shapes this client speaks,
 * each with the most it can do. An admin's capabilities are clipped to these
 * limits, never widened, and the preset says which families a service hosts.
 */

import { getPreset, PRESET_IDS, type PresetId } from "../preset.ts";

export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export const IMAGE_FAMILIES = [
  "gpt-image",
  "dall-e-3",
  "dall-e-2",
  "xai-image",
  "gemini-image",
  "imagen",
  "openrouter-image",
  "openai-compatible-image",
  "nova-canvas",
  "titan-image",
  "stability",
] as const;
export type ImageFamily = (typeof IMAGE_FAMILIES)[number];

export type ReferenceType = "image/png" | "image/jpeg" | "image/webp";

/** What a model can do, as shown to people and the chat model. Admin-editable within the family's limits. */
export interface ImageCapabilities {
  readonly generate: boolean;
  readonly edit: { readonly maxReferences: number } | null;
  readonly aspectRatios: ReadonlyArray<AspectRatio>;
  readonly qualities: ReadonlyArray<ImageQuality>;
  readonly transparency: boolean;
  readonly maxCount: number;
}

export interface ImageFamilyInfo {
  readonly id: ImageFamily;
  readonly label: string;
  /** Presets that may host this family, read from the presets themselves. */
  readonly presets: ReadonlyArray<PresetId>;
  /** The most the family can do; admin capabilities are intersected with it. */
  readonly limits: ImageCapabilities;
  /** What a newly registered model starts with, before the admin edits it. */
  readonly defaults: ImageCapabilities;
  readonly referenceTypes: ReadonlyArray<ReferenceType>;
  /** Exact `WxH` per aspect ratio, for families that take sizes. */
  readonly sizes: Readonly<Partial<Record<AspectRatio, string>>> | null;
}

const ALL_RATIOS = ASPECT_RATIOS;
const ALL_QUALITIES = IMAGE_QUALITIES;
const RASTER: ReadonlyArray<ReferenceType> = ["image/png", "image/jpeg", "image/webp"];

/** About one megapixel, both edges multiples of 16, for services that take any size. */
const MEGAPIXEL: Readonly<Record<AspectRatio, string>> = {
  "1:1": "1024x1024",
  "3:2": "1248x832",
  "2:3": "832x1248",
  "4:3": "1152x864",
  "3:4": "864x1152",
  "16:9": "1280x720",
  "9:16": "720x1280",
  "21:9": "1344x576",
};

type Definition = Omit<ImageFamilyInfo, "presets" | "defaults"> & {
  readonly defaults?: Partial<ImageCapabilities>;
};

const DEFINITIONS: ReadonlyArray<Definition> = [
  {
    id: "gpt-image",
    label: "OpenAI GPT Image",
    limits: {
      generate: true,
      edit: { maxReferences: 16 },
      aspectRatios: ["1:1", "3:2", "2:3"],
      qualities: ALL_QUALITIES,
      transparency: true,
      maxCount: 10,
    },
    referenceTypes: RASTER,
    sizes: { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" },
    defaults: { maxCount: 4 },
  },
  {
    id: "dall-e-3",
    label: "OpenAI DALL-E 3",
    limits: {
      generate: true,
      edit: null,
      // 1792x1024 is 7:4, nearest to 16:9 of the ratios people choose from.
      aspectRatios: ["1:1", "16:9", "9:16"],
      // Sent as `standard` and `hd`.
      qualities: ["medium", "high"],
      transparency: false,
      maxCount: 1,
    },
    referenceTypes: [],
    sizes: { "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792" },
  },
  {
    id: "dall-e-2",
    label: "OpenAI DALL-E 2",
    limits: {
      generate: true,
      // One square PNG, checked by normalizeImageRequest.
      edit: { maxReferences: 1 },
      aspectRatios: ["1:1"],
      qualities: [],
      transparency: false,
      maxCount: 10,
    },
    referenceTypes: ["image/png"],
    sizes: { "1:1": "1024x1024" },
    defaults: { maxCount: 4 },
  },
  {
    id: "xai-image",
    label: "xAI Grok Imagine",
    limits: {
      generate: true,
      edit: { maxReferences: 5 },
      aspectRatios: ALL_RATIOS,
      // xAI documents `high` for no model.
      qualities: ["low", "medium"],
      transparency: false,
      maxCount: 10,
    },
    referenceTypes: RASTER,
    sizes: null,
    defaults: { maxCount: 4 },
  },
  {
    id: "gemini-image",
    label: "Google Gemini image",
    limits: {
      generate: true,
      edit: { maxReferences: 14 },
      aspectRatios: ALL_RATIOS,
      qualities: [],
      transparency: false,
      // One call per image.
      maxCount: 4,
    },
    referenceTypes: RASTER,
    sizes: null,
    defaults: { edit: { maxReferences: 3 }, maxCount: 1 },
  },
  {
    id: "imagen",
    label: "Google Imagen",
    limits: {
      generate: true,
      edit: null,
      aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      qualities: [],
      transparency: false,
      maxCount: 4,
    },
    referenceTypes: [],
    sizes: null,
  },
  {
    id: "openrouter-image",
    label: "OpenRouter image",
    limits: {
      generate: true,
      // Varies by provider behind the model.
      edit: { maxReferences: 16 },
      aspectRatios: ALL_RATIOS,
      qualities: ALL_QUALITIES,
      transparency: true,
      // One call per image: single-image providers refuse `n` above one.
      maxCount: 4,
    },
    referenceTypes: RASTER,
    sizes: null,
    defaults: { edit: { maxReferences: 4 }, qualities: [], transparency: false, maxCount: 1 },
  },
  {
    id: "openai-compatible-image",
    label: "OpenAI-compatible image",
    limits: {
      generate: true,
      edit: { maxReferences: 16 },
      aspectRatios: ALL_RATIOS,
      qualities: [],
      transparency: false,
      maxCount: 10,
    },
    referenceTypes: RASTER,
    sizes: MEGAPIXEL,
    defaults: { edit: null, maxCount: 1 },
  },
  {
    id: "nova-canvas",
    label: "Amazon Nova Canvas",
    limits: {
      generate: true,
      // IMAGE_VARIATION takes one to five references.
      edit: { maxReferences: 5 },
      aspectRatios: ALL_RATIOS,
      // Sent as `standard` and `premium`.
      qualities: ["medium", "high"],
      transparency: false,
      maxCount: 5,
    },
    referenceTypes: ["image/png", "image/jpeg"],
    sizes: MEGAPIXEL,
    defaults: { maxCount: 1 },
  },
  {
    id: "titan-image",
    label: "Amazon Titan Image Generator",
    limits: {
      generate: true,
      edit: { maxReferences: 5 },
      aspectRatios: ["1:1", "3:2", "2:3", "16:9"],
      qualities: ["medium", "high"],
      transparency: false,
      maxCount: 5,
    },
    referenceTypes: ["image/png", "image/jpeg"],
    // Titan takes only the sizes in its table.
    sizes: { "1:1": "1024x1024", "3:2": "1152x768", "2:3": "768x1152", "16:9": "1173x640" },
    defaults: { maxCount: 1 },
  },
  {
    id: "stability",
    label: "Stability AI",
    limits: {
      generate: true,
      // Image-to-image exists on SD3.5 only; defaults leave it off for the other models.
      edit: { maxReferences: 1 },
      aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16", "21:9"],
      qualities: [],
      transparency: false,
      maxCount: 1,
    },
    referenceTypes: RASTER,
    sizes: null,
  },
];

const hostedBy = (family: ImageFamily) =>
  PRESET_IDS.filter((id) => getPreset(id).images?.families.includes(family) === true);

const FAMILIES: ReadonlyMap<ImageFamily, ImageFamilyInfo> = new Map(
  DEFINITIONS.map((definition) => [
    definition.id,
    {
      ...definition,
      presets: hostedBy(definition.id),
      defaults: { ...definition.limits, ...definition.defaults },
    },
  ]),
);

export const imageFamily = (id: ImageFamily): ImageFamilyInfo => FAMILIES.get(id)!;

export const isImageFamily = (value: unknown): value is ImageFamily =>
  typeof value === "string" && FAMILIES.has(value as ImageFamily);

export const imageFamiliesFor = (preset: PresetId): ReadonlyArray<ImageFamilyInfo> =>
  IMAGE_FAMILIES.flatMap((id) => {
    const info = imageFamily(id);
    return info.presets.includes(preset) ? [info] : [];
  });

/** Model key patterns per family, matched after any provider prefix (`openai/`, `models/`). */
const KEY_PATTERNS: ReadonlyArray<readonly [ImageFamily, RegExp]> = [
  ["gpt-image", /^(gpt-image|chatgpt-image)/],
  ["dall-e-3", /^dall-e-3/],
  ["dall-e-2", /^dall-e-2/],
  ["xai-image", /^grok-.*image/],
  ["gemini-image", /^gemini-.*image/],
  ["imagen", /^imagen/],
  ["nova-canvas", /^amazon\.nova-canvas/],
  ["titan-image", /^amazon\.titan-image-generator/],
  ["stability", /^stability\.(sd3|stable-image-(ultra|core))/],
  ["openai-compatible-image", /(^|[-_])(image|flux|stable-diffusion|sdxl|sd3|dall-e)/],
];

/** Best guess for a provider model key, for catalog suggestions and admin prefill; null when unknown. */
export const inferImageFamily = (preset: PresetId, modelKey: string): ImageFamily | null => {
  const hosted = imageFamiliesFor(preset).map((info) => info.id);
  if (hosted.length === 0) return null;
  const key = modelKey.toLowerCase();
  // Bedrock geo profiles (`us.amazon.nova-canvas…`) carry a region prefix.
  const bare = key.replace(/^(models\/|[a-z0-9-]+\/)/, "").replace(/^(us|eu|apac|global)\./, "");
  // OpenRouter routes every image model through its own Images API, but hosts
  // chat models too: only a key that reads as an image model is one.
  if (hosted.includes("openrouter-image"))
    return KEY_PATTERNS.some(([, pattern]) => pattern.test(bare)) ? "openrouter-image" : null;
  const match = KEY_PATTERNS.find(
    ([family, pattern]) => hosted.includes(family) && pattern.test(bare),
  );
  return match?.[0] ?? null;
};

const ordered = <T>(all: ReadonlyArray<T>, wanted: ReadonlyArray<T>) =>
  all.filter((item) => wanted.includes(item));

/** Admin capabilities clipped to the family's limits (never widened). */
export const effectiveImageCapabilities = (
  family: ImageFamily,
  admin: ImageCapabilities,
): ImageCapabilities => {
  const limits = imageFamily(family).limits;
  const references =
    admin.edit && limits.edit
      ? Math.min(Math.floor(admin.edit.maxReferences), limits.edit.maxReferences)
      : 0;
  const ratios = ordered(limits.aspectRatios, admin.aspectRatios);
  return {
    generate: admin.generate && limits.generate,
    edit: references >= 1 ? { maxReferences: references } : null,
    // A request always needs a shape; an empty choice falls back to the family's first.
    aspectRatios: ratios.length > 0 ? ratios : limits.aspectRatios.slice(0, 1),
    qualities: ordered(limits.qualities, admin.qualities),
    transparency: admin.transparency && limits.transparency,
    maxCount: Math.max(1, Math.min(Math.floor(admin.maxCount) || 1, limits.maxCount)),
  };
};

/** The capabilities a model starts with, for catalog suggestions and admin prefill. */
export const suggestedImageCapabilities = (
  family: ImageFamily,
  modelKey: string,
): ImageCapabilities => {
  const defaults = imageFamily(family).defaults;
  // On Bedrock only SD3.5 takes an input image; Ultra and Core generate from text.
  if (family === "stability" && !/sd3/i.test(modelKey)) return { ...defaults, edit: null };
  return defaults;
};
