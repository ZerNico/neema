import { Effect } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { Connection, ModelCall } from "./connection.ts";
import { configurationError } from "./errors.ts";

/**
 * OpenAI models from GPT-5.4 on refuse tools beside any reasoning effort but
 * `none` on Chat Completions. Matched on the model id or deployment name,
 * which on Azure is usually the model's.
 */
const RESPONSES_ONLY_TOOLS = /(^|\/)(gpt-5\.(?:[4-9]|\d{2,})|gpt-[6-9])/;

/**
 * Refuses, before anything is sent, a call the resolved policy cannot serve.
 * Reasoning is never silently dropped to make one fit.
 */
export const checkCall = (
  connection: Connection,
  call: ModelCall,
  options: LanguageModel.ProviderOptions,
) => {
  const openai = connection.preset.id === "openai" || connection.preset.id === "azure";
  if (
    openai &&
    connection.settings.format === "chat-completions" &&
    options.tools.length > 0 &&
    call.reasoningEffort &&
    call.reasoningEffort !== "none" &&
    RESPONSES_ONLY_TOOLS.test(call.model)
  )
    return Effect.fail(
      configurationError(
        `${call.model} takes tools with reasoning only on the Responses API. Switch this provider to Responses.`,
      ),
    );
  return Effect.void;
};
