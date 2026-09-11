import { describe, expect, it } from "vitest";
import { normalizeModelSettings } from "./model-config.ts";

describe("normalizeModelSettings", () => {
  it("clears embedding-inapplicable capabilities and output pricing", () => {
    expect(
      normalizeModelSettings({
        displayName: "Embedding",
        type: "embedding",
        contextLength: 8192,
        embeddingDimensions: 1536,
        capabilities: { reasoning: true, tools: true, vision: true, files: true },
        pricing: { input: 0.02, output: 10 },
        enabled: true,
        access: "groups",
        groupIds: ["g1", "g1", "g2"],
      }),
    ).toEqual({
      displayName: "Embedding",
      type: "embedding",
      contextLength: 8192,
      embeddingDimensions: 1536,
      capabilities: { reasoning: false, tools: false, vision: true, files: false },
      pricing: { input: 0.02, output: null },
      enabled: true,
      access: "groups",
      groupIds: ["g1", "g2"],
    });
  });

  it("clears embedding dimensions and group links from public chat models", () => {
    expect(
      normalizeModelSettings({
        displayName: "Chat",
        type: "chat",
        contextLength: null,
        embeddingDimensions: 1536,
        capabilities: { reasoning: true, tools: true, vision: false, files: false },
        pricing: { input: 1, output: 3 },
        enabled: true,
        access: "public",
        groupIds: ["g1"],
      }),
    ).toMatchObject({
      type: "chat",
      embeddingDimensions: null,
      pricing: { input: 1, output: 3 },
      groupIds: [],
    });
  });
});
