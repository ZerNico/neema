import type { ReasoningShape, WireFormat } from "@chat/model-client/presets";

export const FORMAT_LABELS: Record<WireFormat, string> = {
  "chat-completions": "Chat Completions",
  responses: "Responses",
};

export const REASONING_LABELS: Record<ReasoningShape, string> = {
  none: "Not sent",
  flat: "reasoning_effort",
  nested: "reasoning.effort",
};
