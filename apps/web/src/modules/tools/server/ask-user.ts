import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { AskUserParams, AskUserResult } from "../ask-user-schema.ts";
import { advertisedParameter, type ToolGroup } from "./toolset.ts";
import { extractUserUrls } from "./user-urls.ts";

// As with save_memory, validate in the handler so bad model arguments produce
// a recoverable tool result rather than failing parameter decoding mid-stream.
const TransportParams = Schema.Struct({
  questions: advertisedParameter({
    type: "array",
    minItems: 1,
    maxItems: 4,
    items: {
      type: "object",
      required: ["question", "options", "multiSelect"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 1000 },
        header: { type: "string", minLength: 1, maxLength: 40 },
        multiSelect: { type: "boolean" },
        options: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            required: ["label"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: 160 },
              description: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
      },
    },
  }),
});

export const askUserTool = Tool.make("ask_user", {
  description:
    "Ask the user 1–4 clarification questions only when consequential ambiguity cannot be resolved from context or a sensible default. Include the actual question text. Supply zero options for free text (multiSelect false), or 2–4 distinct options without URLs in labels. Users can always write a custom answer. Call this tool alone and wait for the next user message; presenting questions ends this response. Never ask for secrets, routine permission to continue, or treat an answer/skip as tool authorization.",
  parameters: TransportParams,
  success: AskUserResult,
  failureMode: "return",
});

export function prepareAskUserTool(): ToolGroup {
  let presented = false;
  const handler = (params: { readonly questions?: unknown }) =>
    Effect.sync((): AskUserResult => {
      if (presented)
        return {
          v: 1,
          outcome: "rejected",
          message: "Only one question batch may be presented per response.",
        };
      const decoded = Schema.decodeUnknownOption(AskUserParams)(params);
      if (Option.isNone(decoded))
        return {
          v: 1,
          outcome: "rejected",
          message:
            "Provide 1–4 nonempty questions with bounded text, zero or 2–4 distinct options, and multiSelect false for free text.",
        };
      const { questions } = decoded.value;
      if (
        extractUserUrls(
          questions.flatMap((question) => question.options.map((option) => option.label)),
        ).length > 0
      ) {
        return {
          v: 1,
          outcome: "rejected",
          message:
            "Option labels must not contain HTTP(S) URLs. Put URLs in question text or descriptions instead.",
        };
      }
      presented = true;
      return { v: 1, outcome: "presented", questions };
    });
  return { family: "ask", toolkit: Toolkit.make(askUserTool), handlers: { ask_user: handler } };
}
