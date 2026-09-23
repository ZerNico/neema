import { describe, expect, it } from "vitest";
import { actionableReasoningEfforts, normalizeModelSettings } from "./model-config.ts";

describe("actionableReasoningEfforts", () => {
  it("offers only configured levels on capable transports", () => {
    const capabilities = {
      reasoning: true,
      reasoningEfforts: ["low", "high"] as const,
      tools: false,
      vision: false,
      files: false,
    };
    expect(actionableReasoningEfforts(capabilities, "openrouter", "unsupported")).toEqual([
      "low",
      "high",
    ]);
    expect(actionableReasoningEfforts(capabilities, "openai-compatible", "flat")).toEqual([
      "low",
      "high",
    ]);
    expect(actionableReasoningEfforts(capabilities, "openai-compatible", "nested")).toEqual([
      "low",
      "high",
    ]);
    expect(actionableReasoningEfforts(capabilities, "openai-compatible", "unsupported")).toEqual(
      [],
    );
    expect(
      actionableReasoningEfforts({ ...capabilities, reasoning: false }, "openrouter", "nested"),
    ).toEqual([]);
  });
});

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

  it("drops effort levels when reasoning is disabled or the model is an embedding", () => {
    const common = {
      displayName: "Model",
      contextLength: null,
      enabled: true,
      access: "public" as const,
      groupIds: [],
      pricing: null,
      capabilities: {
        reasoning: false,
        reasoningEfforts: ["low", "high"] as ("low" | "high")[],
        tools: false,
        vision: false,
        files: false,
      },
    };
    expect(
      normalizeModelSettings({ ...common, type: "chat", embeddingDimensions: null }).capabilities,
    ).toEqual({ reasoning: false, tools: false, vision: false, files: false });
    expect(
      normalizeModelSettings({ ...common, type: "embedding", embeddingDimensions: null })
        .capabilities,
    ).toEqual({ reasoning: false, tools: false, vision: false, files: false });
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
