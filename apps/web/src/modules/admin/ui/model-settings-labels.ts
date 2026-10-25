import type { ModelFormat, ModelType } from "~/modules/providers/model-config.ts";
import { m } from "~/paraglide/messages.js";

/**
 * Sentence-case labels for the type enum wherever it is shown to a person
 * (badges, selects), read when shown. The enum values themselves stay lowercase on the wire.
 */
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  get chat() {
    return m.admin_model_type_chat();
  },
  get embedding() {
    return m.admin_model_type_embedding();
  },
  get image() {
    return m.admin_model_type_image();
  },
};

/** API names, the same in every language. */
export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  responses: "Responses",
  "chat-completions": "Chat Completions",
};
