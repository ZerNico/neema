import type { ModelFormat, ModelType } from "~/modules/providers/model-config.ts";

/**
 * Sentence-case labels for the type enum wherever it is shown to a person
 * (badges, selects). The enum values themselves stay lowercase on the wire.
 */
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  embedding: "Embedding",
};

export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  responses: "Responses",
  "chat-completions": "Chat Completions",
};
