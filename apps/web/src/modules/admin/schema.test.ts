import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CreateModelInput, UpdateProviderInput } from "./schema.ts";

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

describe("UpdateProviderInput", () => {
  it("accepts only known setting values", () => {
    const decode = Schema.decodeUnknownSync(UpdateProviderInput);
    for (const reasoning of ["none", "flat", "nested"]) {
      expect(decode({ providerId: "p1", settings: { reasoning } })).toMatchObject({
        settings: { reasoning },
      });
    }
    expect(() => decode({ providerId: "p1", settings: { reasoning: "thinking" } })).toThrow(
      /Expected "none" \| "flat" \| "nested"\n  at \["settings"\]\["reasoning"\]/,
    );
    expect(() => decode({ providerId: "p1", settings: { keyHeader: "x-key\nevil: 1" } })).toThrow(
      /at \["settings"\]\["keyHeader"\]/,
    );
  });
});

describe("CreateModelInput", () => {
  it("accepts complete embedding settings with input-only pricing", () => {
    expect(
      decodeCreate({
        ...common,
        type: "embedding",
        embeddingDimensions: 1536,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: false,
          vision: true,
          files: false,
        },
        pricing: { input: 0.02, output: null },
      }),
    ).toMatchObject({ type: "embedding", embeddingDimensions: 1536 });
  });

  it("accepts known reasoning efforts and rejects invented levels", () => {
    const chat = {
      ...common,
      type: "chat",
      embeddingDimensions: null,
      capabilities: {
        imageOutput: false,
        reasoning: true,
        reasoningEfforts: ["minimal", "xhigh", "max"],
        tools: false,
        vision: false,
        files: false,
      },
      pricing: null,
    };
    expect(decodeCreate(chat).capabilities).toMatchObject({
      reasoningEfforts: ["minimal", "xhigh", "max"],
    });
    expect(() =>
      decodeCreate({
        ...chat,
        capabilities: { ...chat.capabilities, reasoningEfforts: ["ultra"] },
      }),
    ).toThrow(/at \["capabilities"\]\["reasoningEfforts"\]\[0\]/);
  });

  it("rejects unsupported model types and cross-type fields", () => {
    expect(() =>
      decodeCreate({
        ...common,
        type: "audio",
        embeddingDimensions: null,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: false,
          vision: true,
          files: false,
        },
        pricing: null,
      }),
    ).toThrow(/Expected \{ readonly "type": "chat"/);

    expect(() =>
      decodeCreate({
        ...common,
        type: "embedding",
        embeddingDimensions: 1536,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: true,
          vision: true,
          files: false,
        },
        pricing: { input: 0.02, output: null },
      }),
    ).toThrow(/Expected false\n  at \["capabilities"\]\["tools"\]/);

    expect(() =>
      decodeCreate({
        ...common,
        type: "chat",
        embeddingDimensions: null,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: false,
          vision: false,
          files: false,
        },
        pricing: { input: 1, output: null },
      }),
    ).toThrow(/Expected number\n  at \["pricing"\]\["output"\]/);
  });
});
