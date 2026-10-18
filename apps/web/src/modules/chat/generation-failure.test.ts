import { describe, expect, it } from "vitest";
import { generationFailureReason } from "./generation-failure.ts";

describe("generationFailureReason", () => {
  it("gives the provider's reason without the engine's wrapping", () => {
    expect(
      generationFailureReason(
        "Cause([Fail(ProviderUnreachable: ModelClient.request: InvalidKey: Verify your API key is correct. API key expired.)])",
      ),
    ).toBe("InvalidKey: Verify your API key is correct. API key expired.");
  });

  it("uses the app's own words for a failure it names", () => {
    expect(generationFailureReason("GenerationFailed [ResponseFiltered]")).toBe(
      "The model declined this request. Try rephrasing it, or choose another model.",
    );
  });

  it("has no reason for an answer that recorded none", () => {
    expect(generationFailureReason(null)).toBeNull();
  });
});
