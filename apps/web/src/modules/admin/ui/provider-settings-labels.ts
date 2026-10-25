import type { AuthKind, ReasoningShape, WireFormat } from "@chat/model-client/presets";
import { m } from "~/paraglide/messages.js";

/** API names, the same in every language. */
export const FORMAT_LABELS: Record<WireFormat, string> = {
  "chat-completions": "Chat Completions",
  responses: "Responses",
  messages: "Anthropic Messages",
};

/** Read when shown, in the reader's language. */
export const AUTH_LABELS: Record<AuthKind, string> = {
  get key() {
    return m.admin_auth_key();
  },
  get aws() {
    return m.admin_auth_aws();
  },
};

/** Request fields stay as they are; only "Not sent" is words. */
export const REASONING_LABELS: Record<ReasoningShape, string> = {
  get none() {
    return m.admin_reasoning_none();
  },
  flat: "reasoning_effort",
  nested: "reasoning.effort",
};
