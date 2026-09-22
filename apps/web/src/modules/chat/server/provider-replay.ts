import { Generated } from "@effect/ai-openrouter";
import { Schema } from "effect";
import { ASSISTANT_FILE_LIMITS } from "../assistant-output.ts";

export interface ProviderReplay {
  v: 1;
  providerId: string;
  modelKey: string;
  turns: ReadonlyArray<{
    turnIndex: number;
    startOffset: number;
    endOffset: number;
    reasoningDetails: typeof Generated.ChatReasoningDetails.Encoded;
  }>;
}
/** Only the documented OpenRouter schema is accepted; no arbitrary provider dumps. */
export const replayDetails = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(Generated.ChatReasoningDetails)(value);
  } catch {
    // Schema diagnostics include offending values; opaque provider state is private.
    throw new Error("The provider returned invalid image replay metadata.");
  }
};
export const boundedReplay = (replay: ProviderReplay): ProviderReplay => {
  if (Buffer.byteLength(JSON.stringify(replay), "utf8") > ASSISTANT_FILE_LIMITS.replayBytes)
    throw new Error("Image replay metadata exceeds the supported limit.");
  return replay;
};
