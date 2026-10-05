import { Effect } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { Connection, ModelCall } from "./connection.ts";
import { configurationError } from "./errors.ts";

/**
 * OpenAI models from GPT-5.4 on refuse tools beside any reasoning effort but
 * `none` on Chat Completions. Matched on the model id, a deployment name
 * (on Azure usually the model's) or a Bedrock id (`us.openai.gpt-5.6-sol`).
 */
const RESPONSES_ONLY_TOOLS = /(^|[/.])(gpt-5\.(?:[4-9]|\d{2,})|gpt-[6-9])/;

/** What fixes it, per service: Azure's API is each model's, Bedrock's is always Chat Completions. */
const REMEDY: Partial<Record<string, string>> = {
  azure: "Set this model's API to Responses.",
  bedrock: "Bedrock is used over Chat Completions here, so turn reasoning off for this model.",
};

/**
 * Refuses, before anything is sent, a call the resolved policy cannot serve.
 * Reasoning is never silently dropped to make one fit.
 */
export const checkCall = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
) => {
  const remedy = REMEDY[connection.preset.id];
  if (
    remedy &&
    connection.settings.format === "chat-completions" &&
    options.tools.length > 0 &&
    call.reasoningEffort &&
    call.reasoningEffort !== "none" &&
    RESPONSES_ONLY_TOOLS.test(call.model)
  )
    return Effect.fail(
      configurationError(
        `${call.model} takes tools with reasoning only on the Responses API. ${remedy}`,
      ),
    );
  return Effect.void;
};
