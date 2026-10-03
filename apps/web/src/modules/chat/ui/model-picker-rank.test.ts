import { describe, expect, it } from "vitest";
import { rankModels, type PickableModel } from "./model-picker-rank.ts";

const model = (
  id: string,
  displayName: string,
  providerName: string,
  extra: Partial<PickableModel> = {},
): PickableModel => ({
  id,
  displayName,
  providerName,
  contextLength: null,
  capabilities: { imageOutput: false, reasoning: false, tools: false, vision: false, files: false },
  ...extra,
});

// Already in the admin's order, which interleaves providers on purpose.
const MODELS = [
  model("sonnet", "Claude Sonnet 5", "Anthropic"),
  model("gpt", "GPT-5", "OpenAI", {
    capabilities: { imageOutput: false, reasoning: true, tools: true, vision: true, files: false },
  }),
  model("opus", "Claude Opus 5", "Anthropic"),
  model("mini", "Mini", "OpenAI", { description: "Cheap, like GPT-5 nano" }),
];

describe("rankModels", () => {
  it("puts a name hit above a description hit and keeps the admin's order on ties", () => {
    expect(rankModels(MODELS, "gpt").map((m) => m.id)).toEqual(["gpt", "mini"]);
    expect(rankModels(MODELS, "claude").map((m) => m.id)).toEqual(["sonnet", "opus"]);
  });

  it("ranks a word start above a match inside the name", () => {
    const models = [model("x", "Turbo Opus", "P"), model("y", "Opus", "P")];
    expect(rankModels(models, "opus").map((m) => m.id)).toEqual(["y", "x"]);
  });

  it("finds a model by its provider and needs every word to match", () => {
    expect(rankModels(MODELS, "openai").map((m) => m.id)).toEqual(["gpt", "mini"]);
    expect(rankModels(MODELS, "anthropic gpt")).toEqual([]);
  });
});
