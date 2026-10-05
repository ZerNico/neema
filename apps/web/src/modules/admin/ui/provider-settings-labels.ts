import type { AuthKind, ReasoningShape, WireFormat } from "@chat/model-client/presets";

export const FORMAT_LABELS: Record<WireFormat, string> = {
  "chat-completions": "Chat Completions",
  responses: "Responses",
  messages: "Anthropic Messages",
};

export const AUTH_LABELS: Record<AuthKind, string> = {
  key: "API key",
  aws: "Access key",
};

export const REASONING_LABELS: Record<ReasoningShape, string> = {
  none: "Not sent",
  flat: "reasoning_effort",
  nested: "reasoning.effort",
};
