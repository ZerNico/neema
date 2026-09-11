import { describe, expect, it } from "vitest";
import { boundedReplay, replayDetails } from "./provider-replay.ts";
describe("private provider replay validation", () => {
  it("does not expose invalid opaque values in diagnostics", () => {
    const secret = "data:image/png;base64,private-signature";
    expect(() => replayDetails([{ type: "invalid", data: secret }])).toThrow(
      "The provider returned invalid image replay metadata.",
    );
    try {
      replayDetails([{ type: "invalid", data: secret }]);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
  it("bounds metadata without retaining parse diagnostics", () => {
    expect(() =>
      boundedReplay({
        v: 1,
        providerId: "p",
        modelKey: "m",
        turns: [
          {
            turnIndex: 0,
            startOffset: 0,
            endOffset: 0,
            reasoningDetails: [{ type: "reasoning.encrypted", data: "x".repeat(300_000) }],
          },
        ],
      }),
    ).toThrow("Image replay metadata exceeds the supported limit.");
  });
});
