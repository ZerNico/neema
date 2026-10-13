import { describe, expect, it } from "vitest";
import { getPreset, PRESET_IDS } from "../preset.ts";
import {
  effectiveImageCapabilities,
  IMAGE_FAMILIES,
  imageFamiliesFor,
  imageFamily,
  inferImageFamily,
  isImageFamily,
  suggestedImageCapabilities,
  type ImageCapabilities,
} from "./families.ts";
import { normalizeImageRequest } from "./normalize.ts";
import { gif, jpeg, png, reference } from "./test-server.ts";

const everything: ImageCapabilities = {
  generate: true,
  edit: { maxReferences: 99 },
  aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
  qualities: ["low", "medium", "high"],
  transparency: true,
  maxCount: 99,
};

describe("image families", () => {
  it("agree with the presets that host them", () => {
    for (const id of PRESET_IDS)
      for (const family of getPreset(id).images?.families ?? [])
        expect(imageFamily(family).presets).toContain(id);
    expect(imageFamiliesFor("bedrock").map((info) => info.id)).toEqual([
      "nova-canvas",
      "titan-image",
      "stability",
    ]);
    expect(imageFamiliesFor("deepseek")).toEqual([]);
    expect(imageFamily("imagen").presets).toEqual([]);
    expect(IMAGE_FAMILIES.every(isImageFamily)).toBe(true);
    expect(isImageFamily("midjourney")).toBe(false);
  });

  it("guesses a family from the model key, only among the preset's families", () => {
    expect(inferImageFamily("openai", "gpt-image-2.5-flare")).toBe("gpt-image");
    expect(inferImageFamily("openai", "dall-e-3")).toBe("dall-e-3");
    expect(inferImageFamily("openai", "gpt-5.4")).toBeNull();
    expect(inferImageFamily("azure", "gpt-image-1")).toBe("gpt-image");
    expect(inferImageFamily("azure", "dall-e-2")).toBeNull();
    expect(inferImageFamily("xai", "grok-imagine-image-2.0")).toBe("xai-image");
    expect(inferImageFamily("gemini", "models/gemini-3.1-flash-image")).toBe("gemini-image");
    expect(inferImageFamily("gemini", "imagen-4.0-generate-001")).toBeNull();
    expect(inferImageFamily("bedrock", "amazon.nova-canvas-v1:0")).toBe("nova-canvas");
    expect(inferImageFamily("bedrock", "us.amazon.nova-canvas-v1:0")).toBe("nova-canvas");
    expect(inferImageFamily("bedrock", "amazon.titan-image-generator-v2:0")).toBe("titan-image");
    expect(inferImageFamily("bedrock", "stability.sd3-5-large-v1:0")).toBe("stability");
    expect(inferImageFamily("bedrock", "stability.stable-image-remove-background-v1:0")).toBeNull();
    expect(inferImageFamily("vercel", "openai/gpt-image-2")).toBe("gpt-image");
    expect(inferImageFamily("vercel", "bfl/flux-2-pro")).toBe("openai-compatible-image");
    expect(inferImageFamily("openrouter", "google/gemini-2.5-flash-image")).toBe(
      "openrouter-image",
    );
    expect(inferImageFamily("openrouter", "black-forest-labs/flux.2-pro")).toBe("openrouter-image");
    // OpenRouter hosts chat models too; a typed chat key stays a chat model.
    expect(inferImageFamily("openrouter", "anthropic/claude-sonnet-5.5")).toBeNull();
    expect(inferImageFamily("openrouter", "openai/gpt-6.1")).toBeNull();
    expect(inferImageFamily("groq", "anything-image")).toBeNull();
  });

  it("clips admin capabilities to the family's limits and never widens them", () => {
    expect(effectiveImageCapabilities("dall-e-3", everything)).toEqual({
      generate: true,
      edit: null,
      aspectRatios: ["1:1", "16:9", "9:16"],
      qualities: ["medium", "high"],
      transparency: false,
      maxCount: 1,
    });
    expect(
      effectiveImageCapabilities("gpt-image", {
        generate: false,
        edit: { maxReferences: 3 },
        aspectRatios: ["16:9", "3:2"],
        qualities: ["high"],
        transparency: false,
        maxCount: 0,
      }),
    ).toEqual({
      generate: false,
      edit: { maxReferences: 3 },
      aspectRatios: ["3:2"],
      qualities: ["high"],
      transparency: false,
      maxCount: 1,
    });
    // No ratio left: the family's first, so a request still has a shape.
    expect(
      effectiveImageCapabilities("titan-image", { ...everything, aspectRatios: ["21:9"] })
        .aspectRatios,
    ).toEqual(["1:1"]);
  });

  it("suggests image-to-image only for the Stability models that have it", () => {
    expect(suggestedImageCapabilities("stability", "stability.sd3-5-large-v1:0").edit).toEqual({
      maxReferences: 1,
    });
    expect(
      suggestedImageCapabilities("stability", "stability.stable-image-ultra-v1:1").edit,
    ).toBeNull();
  });
});

describe("normalizeImageRequest", () => {
  const base = { prompt: "A lighthouse", references: [] };

  it("passes a request that fits unchanged", () => {
    expect(
      normalizeImageRequest("gpt-image", everything, {
        ...base,
        aspectRatio: "3:2",
        quality: "high",
        background: "transparent",
        count: 2,
      }),
    ).toEqual({
      request: {
        prompt: "A lighthouse",
        references: [],
        aspectRatio: "3:2",
        size: "1536x1024",
        quality: "high",
        background: "transparent",
        count: 2,
      },
      adjustments: [],
    });
  });

  it("moves to the nearest ratio and size, and says so", () => {
    const wide = normalizeImageRequest("gpt-image", everything, { ...base, aspectRatio: "16:9" });
    expect(wide.request).toMatchObject({ aspectRatio: "3:2", size: "1536x1024" });
    expect(wide.adjustments).toEqual(["16:9 is not available, so the image is 3:2."]);
    const tall = normalizeImageRequest("dall-e-3", everything, { ...base, aspectRatio: "2:3" });
    expect(tall.request).toMatchObject({ aspectRatio: "9:16", size: "1024x1792" });
    expect(normalizeImageRequest("gpt-image", everything, base).request.aspectRatio).toBe("1:1");
    expect(normalizeImageRequest("xai-image", everything, base).request.size).toBeNull();
  });

  it("maps quality to the nearest offered and drops it where there is none", () => {
    const dalle = normalizeImageRequest("dall-e-3", everything, { ...base, quality: "low" });
    expect(dalle.request.quality).toBe("medium");
    expect(dalle.adjustments).toEqual(["low quality is not available, so medium is used."]);
    const gemini = normalizeImageRequest("gemini-image", everything, { ...base, quality: "high" });
    expect(gemini.request.quality).toBeNull();
    expect(gemini.adjustments).toEqual(["This model has no quality setting, so high was ignored."]);
    expect(normalizeImageRequest("gpt-image", everything, base).request.quality).toBeNull();
  });

  it("sends the cheapest allowed quality when none was asked and the admin narrowed them", () => {
    const lowOnly = { ...everything, qualities: ["low"] as const };
    expect(normalizeImageRequest("gpt-image", lowOnly, base).request.quality).toBe("low");
    const upper = { ...everything, qualities: ["medium", "high"] as const };
    expect(normalizeImageRequest("gpt-image", upper, base).request.quality).toBe("medium");
    // Every quality the family has is allowed: the provider's own default stands.
    expect(normalizeImageRequest("dall-e-3", everything, base).request.quality).toBeNull();
  });

  it("drops transparency a model cannot make", () => {
    const result = normalizeImageRequest("nova-canvas", everything, {
      ...base,
      background: "transparent",
    });
    expect(result.request.background).toBeNull();
    expect(result.adjustments).toEqual([
      "This model cannot make transparent backgrounds, so the background is opaque.",
    ]);
  });

  it("clamps the count to the model's maximum", () => {
    const result = normalizeImageRequest(
      "gpt-image",
      { ...everything, maxCount: 2 },
      {
        ...base,
        count: 5,
      },
    );
    expect(result.request.count).toBe(2);
    expect(result.adjustments).toEqual([
      "This model makes at most 2 images per request, so 2 images will be made.",
    ]);
    expect(
      normalizeImageRequest("gpt-image", everything, { ...base, count: 0 }).request.count,
    ).toBe(1);
  });

  it("refuses references for a model without editing, or of a type it cannot read", () => {
    expect(
      normalizeImageRequest("dall-e-3", everything, {
        ...base,
        references: [reference("a.png", png())],
      }).refusal,
    ).toBe("This model only creates new images from a prompt and cannot use reference images.");
    expect(
      normalizeImageRequest("nova-canvas", everything, {
        ...base,
        references: [reference("a.gif", gif(), "image/gif")],
      }).refusal,
    ).toBe("a.gif is not a PNG or JPEG image, which this model needs.");
    expect(
      normalizeImageRequest("dall-e-2", everything, {
        ...base,
        references: [reference("a.jpg", jpeg(), "image/jpeg")],
      }).refusal,
    ).toBe("a.jpg is not a PNG image, which this model needs.");
    expect(
      normalizeImageRequest("dall-e-2", everything, {
        ...base,
        references: [reference("wide.png", png(200, 100))],
      }).refusal,
    ).toBe("wide.png is not square, and DALL-E 2 edits only square PNG images.");
    expect(
      normalizeImageRequest("gpt-image", { ...everything, generate: false }, base).refusal,
    ).toBe("This model only edits images, so it needs at least one reference image.");
  });

  it("keeps the first references a model takes and follows the first one's shape", () => {
    const result = normalizeImageRequest(
      "gpt-image",
      { ...everything, edit: { maxReferences: 1 } },
      {
        ...base,
        references: [reference("tall.jpg", jpeg(400, 600), "image/png"), reference("b.png", png())],
      },
    );
    expect(result.refusal).toBeUndefined();
    expect(result.request.references).toHaveLength(1);
    // The sniffed type wins over the claimed one.
    expect(result.request.references[0]!.mediaType).toBe("image/jpeg");
    expect(result.request.aspectRatio).toBe("2:3");
    expect(result.adjustments).toEqual([
      "This model takes at most one reference image, so only the first one was used.",
    ]);
  });

  it("tells that Stability's image-to-image keeps the reference's shape", () => {
    const result = normalizeImageRequest("stability", everything, {
      ...base,
      aspectRatio: "16:9",
      references: [reference("a.png", png(100, 100))],
    });
    expect(result.request.aspectRatio).toBe("1:1");
    expect(result.adjustments).toEqual([
      "With a reference image this model keeps the reference’s aspect ratio.",
    ]);
  });
});
