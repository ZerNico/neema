import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CreateModelInput } from "./schema.ts";

const decodeCreate = Schema.decodeUnknownSync(CreateModelInput);

const common = {
  providerId: "p1",
  modelKey: "model-1",
  displayName: "Model",
  contextLength: null,
  enabled: true,
  access: "public" as const,
  groupIds: [],
};

describe("CreateModelInput", () => {
  it("accepts complete embedding settings with input-only pricing", () => {
    expect(
      decodeCreate({
        ...common,
        type: "embedding",
        embeddingDimensions: 1536,
        capabilities: { reasoning: false, tools: false, vision: true, files: false },
        pricing: { input: 0.02, output: null },
      }),
    ).toMatchObject({ type: "embedding", embeddingDimensions: 1536 });
  });

  it("rejects unsupported model types and cross-type fields", () => {
    expect(() =>
      decodeCreate({
        ...common,
        type: "image",
        embeddingDimensions: null,
        capabilities: { reasoning: false, tools: false, vision: true, files: false },
        pricing: null,
      }),
    ).toThrow();

    expect(() =>
      decodeCreate({
        ...common,
        type: "embedding",
        embeddingDimensions: 1536,
        capabilities: { reasoning: false, tools: true, vision: true, files: false },
        pricing: { input: 0.02, output: null },
      }),
    ).toThrow();

    expect(() =>
      decodeCreate({
        ...common,
        type: "chat",
        embeddingDimensions: null,
        capabilities: { reasoning: false, tools: false, vision: false, files: false },
        pricing: { input: 1, output: null },
      }),
    ).toThrow();
  });
});
