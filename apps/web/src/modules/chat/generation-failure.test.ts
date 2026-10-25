import { m } from "~/paraglide/messages.js";
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

  it("words the retry delay with the unit's plural in each language", () => {
    expect(m.chat_failure_retry_in_seconds({ count: 1, amount: "1" }, { locale: "de" })).toBe(
      "Versuch es in 1 Sekunde noch einmal.",
    );
    expect(m.chat_failure_retry_in_minutes({ count: 2, amount: "2" }, { locale: "en" })).toBe(
      "Try again in 2 minutes.",
    );
  });

  it("has no reason for an answer that recorded none", () => {
    expect(generationFailureReason(null)).toBeNull();
  });
});
