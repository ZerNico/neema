import { describe, expect, it } from "vitest";
import { imageFamily } from "@chat/model-client/image-families";
import {
  emptyModelSettingsDraft,
  imagePricesOf,
  modelSettingsFromDraft,
  shownImagePrices,
  type ModelSettingsDraft,
} from "./model-settings-draft.ts";

const imageDraft = (overrides: Partial<ModelSettingsDraft> = {}): ModelSettingsDraft => ({
  ...emptyModelSettingsDraft(),
  displayName: "GPT Image",
  type: "image",
  imageFamily: "gpt-image",
  imageCapabilities: imageFamily("gpt-image").defaults,
  ...overrides,
});

describe("image model drafts", () => {
  it("saves an image model with its family, clipped capabilities and no chat fields", () => {
    const settings = modelSettingsFromDraft(
      imageDraft({ contextLength: "1000", description: " Good at text " }),
    );
    expect(settings).toMatchObject({
      type: "image",
      description: "Good at text",
      contextLength: null,
      pricing: null,
      imageFamily: "gpt-image",
      imagePricing: null,
    });
  });

  it("keeps per-image prices alone and token prices only together", () => {
    const prices = { ...imageDraft().imagePrices, default: "0.04", high: "0.17" };
    expect(modelSettingsFromDraft(imageDraft({ imagePrices: prices }))?.type).toBe("image");
    expect(
      modelSettingsFromDraft(imageDraft({ imagePrices: prices })) as { imagePricing: unknown },
    ).toMatchObject({ imagePricing: { perImage: { default: 0.04, high: 0.17 } } });
    expect(
      modelSettingsFromDraft(imageDraft({ imagePrices: { ...prices, textInput: "5" } })),
    ).toBeNull();
    const tokens = { ...prices, textInput: "5", imageInput: "10", output: "40" };
    expect(
      imagePricesOf(
        (
          modelSettingsFromDraft(imageDraft({ imagePrices: tokens })) as {
            imagePricing: Parameters<typeof imagePricesOf>[0];
          }
        ).imagePricing,
      ),
    ).toEqual(tokens);
  });

  it("refuses an image model without a family or an aspect ratio", () => {
    expect(modelSettingsFromDraft(imageDraft({ imageFamily: null }))).toBeNull();
    expect(
      modelSettingsFromDraft(
        imageDraft({
          imageCapabilities: { ...imageFamily("gpt-image").defaults, aspectRatios: [] },
        }),
      ),
    ).toBeNull();
  });

  it("clears image fields when a model becomes a chat model", () => {
    const settings = modelSettingsFromDraft(imageDraft({ type: "chat" }));
    expect(settings).toMatchObject({
      type: "chat",
      imageFamily: null,
      imageCapabilities: null,
      imagePricing: null,
    });
  });
});

describe("prices a family change hides", () => {
  it("clears them, so a half-typed token price cannot block Save out of sight", () => {
    const typed = { ...imageDraft().imagePrices, default: "0.04", high: "0.2", textInput: "5" };
    expect(modelSettingsFromDraft(imageDraft({ imagePrices: typed }))).toBeNull();
    const next = imageFamily("dall-e-3");
    const switched = imageDraft({
      imageFamily: next.id,
      imageCapabilities: next.defaults,
      imagePrices: shownImagePrices(typed, next.id, next.defaults.qualities),
    });
    expect(switched.imagePrices).toMatchObject({ default: "0.04", high: "0.2", textInput: "" });
    expect(modelSettingsFromDraft(switched)?.imagePricing).toEqual({
      perImage: { default: 0.04, high: 0.2 },
    });
  });

  it("clears a quality's price when the quality is turned off", () => {
    const prices = { ...imageDraft().imagePrices, low: "0.01", medium: "0.02" };
    expect(shownImagePrices(prices, "gpt-image", ["medium"])).toMatchObject({
      low: "",
      medium: "0.02",
    });
  });
});

describe("token prices", () => {
  it("are kept for Gemini, which reports its usage, when its qualities change", () => {
    const prices = {
      ...imageDraft().imagePrices,
      textInput: "0.3",
      imageInput: "0.3",
      output: "30",
    };
    expect(shownImagePrices(prices, "gemini-image", [])).toMatchObject({
      textInput: "0.3",
      imageInput: "0.3",
      output: "30",
    });
  });
});
