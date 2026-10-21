import { describe, expect, it } from "vitest";
import { imageFamily } from "@chat/model-client/image-families";
import {
  emptyModelSettingsDraft,
  imagePricesFromCatalog,
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

describe("prices the form hides", () => {
  it("clears them on a family change, so a half-typed price cannot block Save out of sight", () => {
    const typed = { ...imageDraft().imagePrices, default: "0.04", high: "0.2", textInput: "5" };
    expect(modelSettingsFromDraft(imageDraft({ imagePrices: typed }))).toBeNull();
    const next = imageFamily("dall-e-3");
    const switched = imageDraft({
      imageFamily: next.id,
      imageCapabilities: next.defaults,
      imagePrices: shownImagePrices(typed, next.defaults.qualities, next.defaults.edit !== null),
    });
    // Token prices stay offered on every family; only the half-typed set blocks Save.
    expect(switched.imagePrices).toMatchObject({ default: "0.04", high: "0.2", textInput: "5" });
    expect(modelSettingsFromDraft(switched)).toBeNull();
  });

  it("clears a quality's price when the quality is turned off", () => {
    const prices = { ...imageDraft().imagePrices, low: "0.01", medium: "0.02" };
    expect(shownImagePrices(prices, ["medium"], true)).toMatchObject({ low: "", medium: "0.02" });
  });

  it("clears the reference fee when edits are turned off", () => {
    const prices = { ...imageDraft().imagePrices, reference: "0.01", textInput: "0.3" };
    expect(shownImagePrices(prices, [], false)).toMatchObject({ reference: "", textInput: "0.3" });
  });
});

describe("image prices", () => {
  it("keep any mix of tokens, per image and per reference", () => {
    const draft = imageDraft({
      imagePrices: {
        ...imageDraft().imagePrices,
        textInput: "5",
        imageInput: "8",
        output: "30",
        default: "0.04",
        reference: "0.01",
      },
    });
    expect(modelSettingsFromDraft(draft)?.imagePricing).toEqual({
      tokens: { textInput: 5, imageInput: 8, output: 30 },
      perImage: { default: 0.04 },
      perReference: 0.01,
    });
    expect(imagePricesOf(modelSettingsFromDraft(draft)?.imagePricing ?? null)).toEqual(
      draft.imagePrices,
    );
  });

  it("fill in from a catalog entry, blank where it states none", () => {
    expect(
      imagePricesFromCatalog({
        tokens: { textInput: 0, imageInput: 9.58, output: 9.58 },
        perReference: 0.01,
      }),
    ).toMatchObject({ textInput: "0", imageInput: "9.58", output: "9.58", reference: "0.01" });
    expect(imagePricesFromCatalog(null)).toEqual(imageDraft().imagePrices);
  });
});
